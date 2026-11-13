#!/usr/bin/env node
// 准备固定版本的 Sparkle 和薄 Node-API 桥；不生成发布密钥，也不修改系统信任。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(desktopRoot, "../..");
export const SPARKLE_VERSION = "2.10.1";
export const SPARKLE_ARCHIVE_SHA256 =
  "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27";
export const SPARKLE_ARCHIVE_URL = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function verifySparkleArchive(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== SPARKLE_ARCHIVE_SHA256) {
    throw new Error("Sparkle archive checksum does not match the pinned release");
  }
}

export async function ensureSparkleDistribution({
  cacheDir = join(workspaceRoot, ".cache/milocode-sparkle"),
} = {}) {
  await mkdir(cacheDir, { recursive: true });
  const archive = join(cacheDir, `Sparkle-${SPARKLE_VERSION}.tar.xz`);
  if (!(await exists(archive))) {
    const temporary = `${archive}.${process.pid}.download`;
    try {
      const response = await fetch(SPARKLE_ARCHIVE_URL, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body)
        throw new Error(`Sparkle download failed (${response.status})`);
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      await verifySparkleArchive(temporary);
      await rename(temporary, archive);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // 已有缓存同样校验，不能因为文件存在就信任它。
  await verifySparkleArchive(archive);
  const distributionDir = join(cacheDir, SPARKLE_VERSION);
  const marker = join(distributionDir, ".verified-archive-sha256");
  if (
    !(await exists(marker)) ||
    (await readFile(marker, "utf8")).trim() !== SPARKLE_ARCHIVE_SHA256
  ) {
    const temporary = await mkdtemp(join(cacheDir, ".extract-"));
    try {
      await exec("tar", [
        "-xf",
        archive,
        "-C",
        temporary,
        "./Sparkle.framework",
        "./bin",
        "./LICENSE",
      ]);
      await writeFile(join(temporary, ".verified-archive-sha256"), `${SPARKLE_ARCHIVE_SHA256}\n`);
      await rm(distributionDir, { recursive: true, force: true });
      await rename(temporary, distributionDir);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return {
    version: SPARKLE_VERSION,
    distributionDir,
    frameworkPath: join(distributionDir, "Sparkle.framework"),
    binDir: join(distributionDir, "bin"),
    licensePath: join(distributionDir, "LICENSE"),
  };
}

export async function prepareMacSparkleRuntime({
  outDir = join(desktopRoot, "resources/milocode-update"),
  targetArch = process.arch,
  nodeIncludeDir = resolve(dirname(process.execPath), "../include/node"),
  cacheDir,
  engineeringTest = false,
} = {}) {
  if (process.platform !== "darwin") throw new Error("Sparkle runtime must be prepared on macOS");
  if (!["arm64", "x64"].includes(targetArch))
    throw new Error(`Unsupported Sparkle architecture: ${targetArch}`);
  if (!(await exists(join(nodeIncludeDir, "node_api.h")))) {
    throw new Error(
      "Node-API headers are unavailable; pass nodeIncludeDir from the configured Node runtime",
    );
  }
  const distribution = await ensureSparkleDistribution({ cacheDir });
  await mkdir(outDir, { recursive: true });
  const nativePath = join(outDir, "milocode_sparkle.node");
  const temporary = `${nativePath}.${process.pid}.tmp`;
  try {
    await exec("xcrun", [
      "clang++",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-fobjc-arc",
      "-fblocks",
      "-std=c++17",
      "-O2",
      "-mmacosx-version-min=13.0",
      "-arch",
      targetArch === "x64" ? "x86_64" : "arm64",
      "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=milocode_sparkle",
      "-I",
      nodeIncludeDir,
      ...(engineeringTest ? ["-DMILOCODE_SPARKLE_ENGINEERING_TEST=1"] : []),
      "-F",
      distribution.distributionDir,
      "-framework",
      "AppKit",
      "-framework",
      "Sparkle",
      "-Wl,-rpath,@loader_path/../../Frameworks",
      "-Wl,-rpath,@loader_path",
      join(desktopRoot, "native/milocode-sparkle/bridge.mm"),
      "-o",
      temporary,
    ]);
    // Apple Silicon 的本地可执行页仍需要 ad-hoc 签名；它免费且不是 Developer ID 或系统信任根。
    await exec("codesign", ["--force", "--sign", "-", temporary]);
    await rename(temporary, nativePath);
  } finally {
    await rm(temporary, { force: true });
  }
  const frameworkPath = join(outDir, "Sparkle.framework");
  await rm(frameworkPath, { recursive: true, force: true });
  await cp(distribution.frameworkPath, frameworkPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  await copyFile(distribution.licensePath, join(outDir, "SPARKLE-LICENSE"));
  await writeFile(
    join(outDir, "sparkle-runtime.json"),
    `${JSON.stringify(
      {
        version: SPARKLE_VERSION,
        archiveSha256: SPARKLE_ARCHIVE_SHA256,
        targetArch,
        napiVersion: 8,
      },
      null,
      2,
    )}\n`,
  );
  return { ...distribution, nativePath, frameworkPath, outDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetArch = process.env.MILOCODE_SPARKLE_ARCH || process.arch;
  const result = await prepareMacSparkleRuntime({ targetArch });
  console.log(`[milocode-update] Sparkle ${result.version} ${targetArch} prepared`);
}
