import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  getAgentDesktopExtraResources,
  getAgentDesktopRelease,
  resolveAgentDesktopBuilderTarget,
  resolveAgentDesktopResources,
} from "./config.mjs";
import {
  assertAgentDesktopFileHash,
  prepareAgentDesktopResources,
  verifyAgentDesktopResources,
  verifyPackagedAgentDesktopResources,
} from "./assets.mjs";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "milocode-agent-desktop-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Mac and Windows resolve isolated sources into the same packaged sidecar directory", () => {
  const desktopRoot = join(tmpdir(), "desktop");
  const resourcesDir = join(tmpdir(), "package", "resources");
  for (const [platform, arch, binaryName] of [
    ["darwin", "arm64", "agent-desktop"],
    ["darwin", "x64", "agent-desktop"],
    ["win32", "x64", "agent-desktop.exe"],
  ]) {
    const source = resolveAgentDesktopResources({ platform, arch, desktopRoot });
    assert.equal(
      source.directory,
      join(desktopRoot, "resources", "agent-desktop", `${platform}-${arch}`),
    );
    const packaged = resolveAgentDesktopResources({ platform, arch, resourcesDir });
    assert.equal(packaged.binaryPath, join(resourcesDir, "agent-desktop", binaryName));
    assert.deepEqual(getAgentDesktopExtraResources({ platform, arch }, desktopRoot), [
      { from: source.directory, to: "agent-desktop", filter: ["**/*"] },
    ]);
    assert.equal(source.version, "1.3.1");
    assert.ok(source.archiveUrl.includes("/v1.3.1/"));
    assert.equal(source.archiveSha256.length, 64);
  }
  assert.ok(
    getAgentDesktopRelease({ platform: "darwin", arch: "arm64" }).files[
      "agent-desktop-macos-helper"
    ],
  );
  assert.equal(getAgentDesktopRelease({ platform: "linux", arch: "x64" }), null);
  assert.equal(resolveAgentDesktopResources({ platform: "darwin", arch: "ia32" }), null);
  const intel = getAgentDesktopRelease({ platform: "darwin", arch: "x64" });
  assert.equal(intel.triple, "x86_64-apple-darwin");
  assert.notEqual(
    intel.archiveSha256,
    getAgentDesktopRelease({ platform: "darwin", arch: "arm64" }).archiveSha256,
  );
  assert.ok(intel.files["agent-desktop-macos-helper"]);
});

test("actual Electron Builder target cannot accidentally package host architecture resources", () => {
  const configuredTarget = { os: "win32", arch: "x64", key: "win32-x64" };
  assert.deepEqual(
    resolveAgentDesktopBuilderTarget({ electronPlatformName: "win32", arch: 1, configuredTarget }),
    { platform: "win32", arch: "x64" },
  );
  assert.throws(
    () =>
      resolveAgentDesktopBuilderTarget({
        electronPlatformName: "darwin",
        arch: 3,
        configuredTarget,
      }),
    /target mismatch/u,
  );
  assert.throws(
    () =>
      resolveAgentDesktopBuilderTarget({
        electronPlatformName: "win32",
        arch: 3,
        configuredTarget,
      }),
    /target mismatch/u,
  );
});

test("SHA verification rejects tampering and symlinks before trusting native bytes", async (t) => {
  const root = await temporary(t);
  const file = join(root, "binary");
  await writeFile(file, "fixed native input");
  const expected = createHash("sha256").update("fixed native input").digest("hex");
  await assertAgentDesktopFileHash(file, expected);
  await writeFile(file, "modified native input");
  await assert.rejects(assertAgentDesktopFileHash(file, expected), /SHA-256 mismatch/u);
  if (process.platform !== "win32") {
    const link = join(root, "symlink");
    await symlink(file, link);
    await assert.rejects(assertAgentDesktopFileHash(link, expected), /regular agent-desktop file/u);
  }
});

test("Mac resource verification rejects missing companion helpers and unexpected files", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "agent-desktop"), "placeholder");
  await assert.rejects(
    verifyAgentDesktopResources({ directory: root, platform: "darwin", arch: "arm64" }),
    /expected.*agent-desktop-macos-helper/u,
  );
  for (const name of [
    "agent-desktop-macos-helper",
    "LICENSE",
    "NOTICE",
    "SOURCES.json",
    "unexpected.exe",
  ])
    await writeFile(join(root, name), "placeholder");
  await assert.rejects(
    verifyAgentDesktopResources({ directory: root, platform: "darwin", arch: "arm64" }),
    /Invalid.*layout/u,
  );
});

test("a corrupt cached release fails before extraction and preserves previous output", async (t) => {
  const root = await temporary(t);
  const cacheRoot = join(root, "cache");
  const desktopRoot = join(root, "desktop");
  const release = getAgentDesktopRelease({ platform: "win32", arch: "x64" });
  const plan = resolveAgentDesktopResources({ platform: "win32", arch: "x64", desktopRoot });
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(plan.directory, { recursive: true });
  await writeFile(join(plan.directory, "old-output"), "untouched");
  await writeFile(join(cacheRoot, release.archiveName), "not a trusted archive");
  await assert.rejects(
    prepareAgentDesktopResources({ platform: "win32", arch: "x64", desktopRoot, cacheRoot }),
    /SHA-256 mismatch/u,
  );
  assert.equal(await readFile(join(plan.directory, "old-output"), "utf8"), "untouched");
  assert.equal(basename(plan.binaryPath), "agent-desktop.exe");
});

test("unsupported targets never create or fetch native resources", async () => {
  assert.equal(await prepareAgentDesktopResources({ platform: "linux", arch: "x64" }), null);
  assert.equal(
    await verifyPackagedAgentDesktopResources({
      resourcesDir: "/nonexistent",
      platform: "linux",
      arch: "x64",
    }),
    null,
  );
});
