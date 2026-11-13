import { createHash } from "node:crypto";
import { access, open, rename, rm } from "node:fs/promises";
import { getRawHeader } from "@electron/asar";

export const ASAR_UNPACK_NATIVE_GLOB = "*.{node,dll,dylib,exe}";

function* packedFiles(directory, parent = "") {
  for (const [name, entry] of Object.entries(directory.files ?? {})) {
    const path = parent ? `${parent}/${name}` : name;
    if (entry.unpacked || entry.link) continue;
    if (entry.files) yield* packedFiles(entry, path);
    else yield { path, entry };
  }
}

export async function assertAppAsarIntegrity(appAsarPath) {
  // Builder 收集 stat 后再次读取文件；若同时运行 typecheck，增长的 tsbuildinfo 会使后续
  // 偏移全部错位。必须在首次 extract/repack 前校验，否则重包会给损坏内容生成新的正确 hash。
  const { header, headerSize } = getRawHeader(appAsarPath);
  const archive = await open(appAsarPath, "r");
  const summary = { filesChecked: 0, bytesChecked: 0 };
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    const archiveSize = (await archive.stat()).size;
    for (const { path, entry } of packedFiles(header)) {
      const start = 8 + headerSize + Number(entry.offset);
      if (
        !Number.isSafeInteger(start) ||
        start < 8 + headerSize ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        start + entry.size > archiveSize ||
        entry.integrity?.algorithm !== "SHA256" ||
        !entry.integrity.hash
      ) {
        throw new Error(`app.asar invalid integrity metadata: ${path}`);
      }
      const hash = createHash("sha256");
      let readSize = 0;
      while (readSize < entry.size) {
        const { bytesRead } = await archive.read(
          buffer,
          0,
          Math.min(buffer.length, entry.size - readSize),
          start + readSize,
        );
        if (bytesRead === 0) throw new Error(`app.asar unexpected end: ${path}`);
        hash.update(buffer.subarray(0, bytesRead));
        readSize += bytesRead;
      }
      if (hash.digest("hex") !== entry.integrity.hash) {
        throw new Error(`app.asar integrity mismatch: ${path}`);
      }
      summary.filesChecked += 1;
      summary.bytesChecked += readSize;
    }
    return summary;
  } finally {
    await archive.close();
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createAppAsarPackArgs({ sourceDir, destinationPath, targetPlatformKey }) {
  return [
    "pack",
    sourceDir,
    destinationPath,
    "--unpack",
    ASAR_UNPACK_NATIVE_GLOB,
    "--unpack-dir",
    `node_modules/node-pty/prebuilds/${targetPlatformKey}`,
  ];
}

export async function replaceAppAsarFromStaging({
  sourceDir,
  appAsarPath,
  targetPlatformKey,
  runAsarCommand,
}) {
  const candidateAsarPath = `${appAsarPath}.next`;
  const candidateUnpackedPath = `${candidateAsarPath}.unpacked`;
  const unpackedPath = `${appAsarPath}.unpacked`;

  await Promise.all([
    rm(candidateAsarPath, { force: true, recursive: true }),
    rm(candidateUnpackedPath, { force: true, recursive: true }),
  ]);

  try {
    runAsarCommand(
      createAppAsarPackArgs({
        sourceDir,
        destinationPath: candidateAsarPath,
        targetPlatformKey,
      }),
    );

    if (!(await pathExists(candidateAsarPath)) || !(await pathExists(candidateUnpackedPath))) {
      // CI 的 TMPDIR 位于隐藏目录 `.tmp`。旧 glob 含 `**/`，@electron/asar 用绝对路径
      // 匹配时不会跨过隐藏目录，导致 native 被写回 asar，同时遗留旧 unpacked 形成物理双份。
      throw new Error(`重打包结果缺少 app.asar 或 app.asar.unpacked: ${candidateAsarPath}`);
    }

    await assertAppAsarIntegrity(candidateAsarPath);

    // 先完整生成候选文件，再替换旧 archive 和 sidecar；不会把上一次打包的跨平台 native 留在 unpacked。
    await rm(unpackedPath, { force: true, recursive: true });
    await rename(candidateUnpackedPath, unpackedPath);
    await rm(appAsarPath, { force: true });
    await rename(candidateAsarPath, appAsarPath);
  } finally {
    await Promise.all([
      rm(candidateAsarPath, { force: true, recursive: true }),
      rm(candidateUnpackedPath, { force: true, recursive: true }),
    ]);
  }
}
