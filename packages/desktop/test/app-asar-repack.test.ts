import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createPackageFromStreams, extractFile, getRawHeader } from "@electron/asar";
import { describe, expect, it } from "vitest";
import {
  ASAR_UNPACK_NATIVE_GLOB,
  assertAppAsarIntegrity,
  replaceAppAsarFromStaging,
} from "../scripts/app-asar-repack.mjs";

const require = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(require.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);

describe("app asar repack", () => {
  it("TMPDIR 含隐藏目录时仍应 unpack native，并删除旧 sidecar 残留", async () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), ".zcode-asar-repack-test-"));
    try {
      const sourceDir = resolve(rootDir, "source");
      const targetPrebuildDir = resolve(sourceDir, "node_modules/node-pty/prebuilds/darwin-arm64");
      const appAsarPath = resolve(rootDir, "app.asar");
      const oldUnpackedPath = `${appAsarPath}.unpacked`;
      mkdirSync(targetPrebuildDir, { recursive: true });
      mkdirSync(oldUnpackedPath, { recursive: true });
      writeFileSync(resolve(targetPrebuildDir, "pty.node"), "native-binary");
      writeFileSync(resolve(targetPrebuildDir, "spawn-helper"), "helper-binary");
      writeFileSync(resolve(oldUnpackedPath, "stale-native.node"), "stale");

      await replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: "darwin-arm64",
        runAsarCommand: (args: string[]) => {
          execFileSync(process.execPath, [asarCliPath, ...args]);
        },
      });

      const header = getRawHeader(appAsarPath).header as {
        files: Record<string, unknown>;
      };
      const nativeHeader = (
        header.files as {
          node_modules: {
            files: {
              "node-pty": {
                files: {
                  prebuilds: {
                    files: {
                      "darwin-arm64": { files: Record<string, { unpacked?: boolean }> };
                    };
                  };
                };
              };
            };
          };
        }
      ).node_modules.files["node-pty"].files.prebuilds.files["darwin-arm64"].files;

      expect(ASAR_UNPACK_NATIVE_GLOB).toBe("*.{node,dll,dylib,exe}");
      expect(nativeHeader["pty.node"].unpacked).toBe(true);
      expect(nativeHeader["spawn-helper"].unpacked).toBe(true);
      expect(
        readFileSync(
          resolve(oldUnpackedPath, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"),
          "utf8",
        ),
      ).toBe("native-binary");
      expect(existsSync(resolve(oldUnpackedPath, "stale-native.node"))).toBe(false);
      await expect(assertAppAsarIntegrity(appAsarPath)).resolves.toEqual({
        filesChecked: 0,
        bytesChecked: 0,
      });
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "应校验真实归档，并拒绝 stat 后文件增长造成的错位（growth=%s）",
    async (growth) => {
      const rootDir = mkdtempSync(resolve(tmpdir(), "zcode-asar-integrity-test-"));
      try {
        const appAsarPath = resolve(rootDir, "app.asar");
        const metadataPath = resolve(rootDir, "build.tsbuildinfo");
        const packagePath = resolve(rootDir, "package.json");
        const metadata = '{"version":"6.0.2"}';
        const packageJson = '{"name":"valid-app","main":"index.js"}';
        writeFileSync(metadataPath, metadata);
        writeFileSync(packagePath, packageJson);
        const capturedStat = statSync(metadataPath);
        if (growth) writeFileSync(metadataPath, metadata + " ".repeat(158));
        const output = await createPackageFromStreams(appAsarPath, [
          {
            path: "build.tsbuildinfo",
            type: "file",
            unpacked: false,
            stat: capturedStat,
            streamGenerator: () => createReadStream(metadataPath),
          },
          {
            path: "package.json",
            type: "file",
            unpacked: false,
            stat: statSync(packagePath),
            streamGenerator: () => createReadStream(packagePath),
          },
        ]);
        await finished(output);

        if (growth) {
          expect(() => JSON.parse(extractFile(appAsarPath, "package.json").toString())).toThrow();
          await expect(assertAppAsarIntegrity(appAsarPath)).rejects.toThrow(
            "app.asar integrity mismatch: build.tsbuildinfo",
          );
        } else {
          await expect(assertAppAsarIntegrity(appAsarPath)).resolves.toEqual({
            filesChecked: 2,
            bytesChecked: Buffer.byteLength(metadata + packageJson),
          });
        }
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
      }
    },
  );
});
