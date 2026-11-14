import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_DESKTOP_LICENSE_SHA256,
  AGENT_DESKTOP_PROVIDER,
  AGENT_DESKTOP_SOURCE,
  agentDesktopPackageRoot,
  agentDesktopScriptRoot,
  getAgentDesktopRelease,
  resolveAgentDesktopResources,
} from "./config.mjs";

const exec = promisify(execFile);
const metadataFiles = ["LICENSE", "NOTICE", "SOURCES.json"];

export async function assertAgentDesktopFileHash(path, expected) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected a regular agent-desktop file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`agent-desktop SHA-256 mismatch: ${path}`);
}

function provenance(release) {
  return {
    provider: AGENT_DESKTOP_PROVIDER,
    version: release.version,
    platform: release.platform,
    arch: release.arch,
    source: AGENT_DESKTOP_SOURCE,
    archiveUrl: release.archiveUrl,
    archiveSha256: release.archiveSha256,
    files: release.files,
    license: "Apache-2.0",
    licenseSource: `${AGENT_DESKTOP_SOURCE}/blob/v${release.version}/LICENSE`,
    licenseSha256: AGENT_DESKTOP_LICENSE_SHA256,
  };
}

export async function verifyAgentDesktopResources({ directory, platform, arch }) {
  const release = getAgentDesktopRelease({ platform, arch });
  if (!release) throw new Error(`Unsupported agent-desktop target: ${platform}-${arch}`);
  const names = (await readdir(directory)).sort();
  const expectedNames = [...Object.keys(release.files), ...metadataFiles].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Invalid agent-desktop resource layout (${release.key}): expected ${expectedNames.join(", ")}; got ${names.join(", ")}`,
    );
  }
  for (const [name, sha256] of Object.entries(release.files)) {
    const path = join(directory, name);
    await assertAgentDesktopFileHash(path, sha256);
    if (process.platform !== "win32" && ((await lstat(path)).mode & 0o111) === 0) {
      throw new Error(`agent-desktop executable permission missing: ${name}`);
    }
  }
  await assertAgentDesktopFileHash(join(directory, "LICENSE"), AGENT_DESKTOP_LICENSE_SHA256);
  const notice = await readFile(join(agentDesktopScriptRoot, "NOTICE"));
  await assertAgentDesktopFileHash(
    join(directory, "NOTICE"),
    createHash("sha256").update(notice).digest("hex"),
  );
  const actual = JSON.parse(await readFile(join(directory, "SOURCES.json"), "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(provenance(release))) {
    throw new Error(`agent-desktop provenance does not match pinned release: ${release.key}`);
  }
  return { ...release, directory, binaryPath: join(directory, release.binaryName) };
}

async function ensureArchive(release, cacheRoot) {
  await mkdir(cacheRoot, { recursive: true });
  const archive = join(cacheRoot, release.archiveName);
  try {
    await lstat(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = await mkdtemp(join(cacheRoot, ".download-"));
    try {
      const downloaded = join(temporary, release.archiveName);
      // curl 复用标准 HTTPS_PROXY；运行时不下载，也不通过 shell 拼接 URL 或参数。
      await exec(
        process.platform === "win32" ? "curl.exe" : "curl",
        [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--retry",
          "2",
          "--connect-timeout",
          "20",
          "--max-time",
          "120",
          "--max-filesize",
          "16777216",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "--output",
          downloaded,
          release.archiveUrl,
        ],
        { timeout: 300_000 },
      );
      await assertAgentDesktopFileHash(downloaded, release.archiveSha256);
      await rename(downloaded, archive);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  // 已有缓存同样校验，损坏时明确失败，不下载另一个版本掩盖问题。
  await assertAgentDesktopFileHash(archive, release.archiveSha256);
  return archive;
}

export async function prepareAgentDesktopResources({
  platform,
  arch,
  desktopRoot = agentDesktopPackageRoot,
  cacheRoot = resolve(desktopRoot, "../../.cache/agent-desktop"),
}) {
  const plan = resolveAgentDesktopResources({ platform, arch, desktopRoot });
  if (!plan) return null;
  try {
    return await verifyAgentDesktopResources(plan);
  } catch {
    // 构建缓存可能来自别的版本；只有重新核验的固定归档可以修复输出。
  }
  const archive = await ensureArchive(plan, cacheRoot);
  const { stdout } = await exec("tar", ["-tzf", archive]);
  const members = stdout.trim().split(/\r?\n/u).sort();
  if (JSON.stringify(members) !== JSON.stringify(Object.keys(plan.files).sort())) {
    throw new Error(`Unexpected files in pinned agent-desktop archive: ${members.join(", ")}`);
  }
  const parent = dirname(plan.directory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".prepare-"));
  try {
    await exec("tar", ["-xzf", archive, "-C", temporary]);
    for (const name of Object.keys(plan.files)) await chmod(join(temporary, name), 0o755);
    await copyFile(join(agentDesktopScriptRoot, "LICENSE"), join(temporary, "LICENSE"));
    await copyFile(join(agentDesktopScriptRoot, "NOTICE"), join(temporary, "NOTICE"));
    await writeFile(
      join(temporary, "SOURCES.json"),
      `${JSON.stringify(provenance(plan), null, 2)}\n`,
    );
    await verifyAgentDesktopResources({ ...plan, directory: temporary });
    await rm(plan.directory, { recursive: true, force: true });
    await rename(temporary, plan.directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return verifyAgentDesktopResources(plan);
}

export async function verifyPackagedAgentDesktopResources({ resourcesDir, platform, arch }) {
  const plan = resolveAgentDesktopResources({ resourcesDir, platform, arch });
  return plan ? verifyAgentDesktopResources(plan) : null;
}
