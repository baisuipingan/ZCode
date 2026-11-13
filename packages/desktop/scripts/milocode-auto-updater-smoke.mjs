import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { signMiloCodeRelease } from "./milocode-release-trust.mjs";

// 工程集成冒烟使用临时签名与不可执行的假安装包；不打开应用、不退出系统进程。
const desktopDir = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(desktopDir, ".e2e-artifacts");
await mkdir(artifactRoot, { recursive: true });
const root = await mkdtemp(resolve(artifactRoot, "milocode-updater-wiring-"));
const key = generateKeyPairSync("ed25519");
const publicKeys = {
  engineering: key.publicKey.export({ type: "spki", format: "pem" }),
};
const base = "https://updates.example.test/milocode/";
const bytes = Buffer.from("MiloCode engineering fixture; this is never an executable.");
const payload = {
  schemaVersion: 1,
  productId: "app.milo.code",
  platform: "win32-x64",
  channel: "stable",
  version: "3.17.3",
  releaseDate: "2026-11-13T00:00:00.000Z",
  releaseNotes: "Engineering fixture",
  files: [
    {
      url: base + "releases/3.17.3/MiloCode.exe",
      size: bytes.length,
      sha512: createHash("sha512").update(bytes).digest("base64"),
    },
  ],
};
const raw = signMiloCodeRelease(payload, {
  keyId: "engineering",
  privateKey: key.privateKey,
});
const channels = new Proxy({}, { get: (_target, key) => String(key) });
const results = [];
async function settle() {
  for (let count = 0; count < 15; count++) await new Promise((resolve) => setTimeout(resolve, 2));
}

for (const scenario of [
  "success",
  "cancel-confirmation",
  "duplicate-install",
  "tampered-download",
  "tampered-cache",
  "changed-release",
  "cold-notes",
  "unsigned",
  "changed-before-install",
  "changed-after-shutdown",
  "unconfigured",
  "mac-native",
]) {
  const installerPath = resolve(root, scenario + ".exe");
  await writeFile(installerPath, bytes);
  const state = {
    scenario,
    checks: 0,
    downloads: 0,
    installs: 0,
    prepares: 0,
    relaunches: 0,
    exits: 0,
    logs: [],
    ipc: new Map(),
    macChecks: 0,
    macOptions: null,
    feed: null,
  };
  const info = {
    ...payload,
    files: payload.files.map((file) => ({ ...file })),
    zcodeReleaseChannel: "stable",
    milocodeSignedEnvelope: raw,
  };
  if (scenario === "unsigned") delete info.milocodeSignedEnvelope;
  class Updater extends EventEmitter {
    installerPath = null;
    setFeedURL(feed) {
      state.feed = feed;
    }
    async checkForUpdates() {
      state.checks++;
      this.emit("checking-for-update");
      this.emit("update-available", info);
    }
    async downloadUpdate() {
      state.downloads++;
      this.installerPath = installerPath;
      if (scenario === "tampered-download" || scenario === "tampered-cache")
        await writeFile(installerPath, Buffer.alloc(bytes.length));
      // 缓存命中故意跳过NSIS hook，验证Main独立准入仍能阻止坏包。
      if (scenario !== "tampered-cache") {
        const failure = await this.verifyUpdateCodeSignature([], installerPath);
        if (failure) throw new Error(failure);
      }
      this.emit("download-progress", {
        percent: 100,
        bytesPerSecond: bytes.length,
        transferred: bytes.length,
        total: bytes.length,
      });
      const downloaded =
        scenario === "changed-release"
          ? {
              ...info,
              version: "3.17.4",
              milocodeSignedEnvelope: signMiloCodeRelease(
                { ...payload, version: "3.17.4" },
                { keyId: "engineering", privateKey: key.privateKey },
              ),
            }
          : info;
      this.emit("update-downloaded", downloaded);
      return [installerPath];
    }
    quitAndInstall() {
      state.installs++;
    }
  }
  const updater = new Updater();
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getVersion: () => "3.17.2",
    relaunch: () => state.relaunches++,
    exit: () => state.exits++,
  });
  const electron = {
    app,
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    ipcMain: { handle: (name, fn) => state.ipc.set(name, fn), on: () => {} },
    Menu: { getApplicationMenu: () => null },
    net: {},
  };
  const shared = {
    DEFAULT_LOCALE: "en-US",
    MILOCODE_UPDATE_BASE_URL: scenario === "unconfigured" ? "" : base,
    MILOCODE_UPDATE_PUBLIC_KEYS_JSON: JSON.stringify(publicKeys),
    PlatformChannels: channels,
    ZCODE_VERSION: "3.17.2",
    desktopMenuMessageIds: {},
    formatDesktopMenuMessage: () => "update",
    getDesktopMenuMessage: () => "update",
  };
  class CancellationToken {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
    dispose() {}
  }
  globalThis.__miloUpdateSmoke = {
    state,
    electron,
    shared,
    updater,
    Updater,
    CancellationToken,
  };
  const modules = {
    electron:
      "export const {app,BrowserWindow,ipcMain,Menu,net}=globalThis.__miloUpdateSmoke.electron;",
    "electron-updater":
      "const {updater,Updater,CancellationToken}=globalThis.__miloUpdateSmoke;export {CancellationToken};export class Provider {constructor(){}};export default {autoUpdater:updater,NsisUpdater:Updater};",
    "@zcode/shared":
      "export const {DEFAULT_LOCALE,MILOCODE_UPDATE_BASE_URL,MILOCODE_UPDATE_PUBLIC_KEYS_JSON,PlatformChannels,ZCODE_VERSION,desktopMenuMessageIds,formatDesktopMenuMessage,getDesktopMenuMessage}=globalThis.__miloUpdateSmoke.shared;",
    logger:
      "const state=globalThis.__miloUpdateSmoke.state;export const logger={info(){},warn(){},error(...args){state.logs.push(args.map(String).join(' '));}};",
    mac: "export function createMiloCodeMacUpdater(options){const {state}=globalThis.__miloUpdateSmoke;state.macOptions=options;return {checkForUpdates(){state.macChecks++;},dispose(){}};}",
  };
  const entry = resolve(root, scenario + ".mjs");
  await build({
    entryPoints: [resolve(desktopDir, "src/main/autoUpdater.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: {
      "process.platform": JSON.stringify(scenario === "mac-native" ? "darwin" : "win32"),
      "process.arch": '"x64"',
    },
    plugins: [
      {
        name: "engineering-fixtures",
        setup(builder) {
          builder.onResolve({ filter: /^(electron|electron-updater|@zcode\/shared)$/ }, (args) => ({
            path: args.path,
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /\/logger\.js$|^\.\/logger\.js$/ }, () => ({
            path: "logger",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /milocode-desktop-update\/index\.js$/ }, () => ({
            path: "mac",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: modules[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const api = await import(pathToFileURL(entry).href);
  const settings = {
    pendingPostUpdateReleaseNotes: {
      version: "3.17.3",
      title: "Fixture",
      markdown: "fixture",
    },
    autoDownloadAndInstallUpdates: true,
    receivePreviewUpdates: true,
  };
  const settingService = {
    get: async () => settings,
    update: async (patch) => Object.assign(settings, patch),
  };
  if (scenario === "cold-notes") {
    await api.hydratePendingPostUpdateReleaseNotes(settingService);
    assert.equal(api.getAutoUpdaterState().kind, "idle");
    assert.equal(updater.installerPath, null);
    results.push("cold release notes cannot restore installation authority");
    continue;
  }
  let completeConfirmation;
  let confirmationCount = 0;
  await api.initAutoUpdater({
    enabled: true,
    ...(scenario === "mac-native"
      ? {}
      : {
          confirmInstall: () => {
            confirmationCount++;
            if (scenario === "duplicate-install")
              return new Promise((resolve) => {
                completeConfirmation = resolve;
              });
            return scenario !== "cancel-confirmation";
          },
        }),
    settingService,
    onBeforeQuitAndInstall: async () => {
      state.prepares++;
      if (scenario === "changed-after-shutdown")
        await writeFile(installerPath, Buffer.alloc(bytes.length));
    },
  });
  await settle();
  assert.equal(
    api.resolveUpdateFeedSourceFromStartupConfig({
      env: { ZCODE_UPDATE_FEED_URL: "https://attacker.invalid" },
      argv: ["--zcode-update-feed-url=https://attacker.invalid"],
    }),
    undefined,
  );
  if (scenario === "unconfigured") {
    assert.equal(state.feed, null);
    assert.equal(state.checks, 0);
    assert.equal(state.ipc.size, 0);
    assert.equal(api.getAutoUpdaterState().enabled, false);
    results.push("missing build configuration stays disabled without fallback");
    continue;
  }
  if (scenario === "mac-native") {
    assert.equal(state.feed, null);
    assert.equal(state.checks, 0);
    assert.equal(state.ipc.size, 0);
    assert.equal(api.isMiloCodeMacUpdaterActive(), true);
    assert.equal(api.getAutoUpdaterState().enabled, true);
    api.checkForUpdateMenuClick();
    api.requestAutoUpdateCheckWithoutWindow();
    assert.equal(state.macChecks, 2);
    assert.equal(await state.macOptions.confirmInstall(), false);
    results.push("Mac delegates exclusively to native updater with denied default install");
    continue;
  }
  if (scenario === "unsigned") {
    assert.equal(api.getAutoUpdaterState().kind, "idle");
    assert.equal(state.downloads, 0);
    results.push("unsigned available event cannot authorize download");
    continue;
  }
  assert.equal(api.getAutoUpdaterState().kind, "update-available", JSON.stringify(state.logs));
  assert.equal(state.downloads, 0);
  assert.equal(state.feed.miloCodePolicy.manifestUrl, base + "stable/win32-x64/latest.json");
  api.refreshAutoUpdaterReleaseChannel(true);
  assert.equal(api.getAutoUpdaterState().channel, "stable");
  api.downloadAvailableUpdate();
  await settle();
  if (
    scenario === "tampered-download" ||
    scenario === "tampered-cache" ||
    scenario === "changed-release"
  ) {
    assert.notEqual(api.getAutoUpdaterState().kind, "update-downloaded");
    assert.equal(state.installs, 0);
    assert.equal(state.prepares, 0);
    results.push(scenario + " rejected before ready");
    continue;
  }
  assert.equal(api.getAutoUpdaterState().kind, "update-downloaded");
  if (scenario === "changed-before-install")
    await writeFile(installerPath, Buffer.alloc(bytes.length));
  const install = state.ipc.get("QuitAndInstallUpdate");
  assert.equal(typeof install, "function");
  if (scenario === "cancel-confirmation") {
    await install();
    assert.equal(state.prepares, 0);
    assert.equal(state.installs, 0);
    assert.equal(api.getAutoUpdaterState().kind, "update-downloaded");
    await install();
    assert.equal(confirmationCount, 2);
    assert.equal(state.prepares, 0);
    results.push("cancelled confirmation keeps ready and unlocks retry without shutdown");
    continue;
  }
  if (scenario === "duplicate-install") {
    const admitted = install();
    await settle();
    await install();
    assert.equal(confirmationCount, 1);
    assert.equal(state.prepares, 0);
    completeConfirmation(true);
    await admitted;
    assert.equal(state.prepares, 1);
    assert.equal(state.installs, 1);
    results.push("duplicate install clicks share one confirmation and installation transaction");
    continue;
  }
  if (scenario === "changed-before-install" || scenario === "changed-after-shutdown") {
    await assert.rejects(install());
    assert.equal(state.installs, 0);
    assert.equal(state.prepares, scenario === "changed-before-install" ? 0 : 1);
    assert.equal(state.relaunches, scenario === "changed-before-install" ? 0 : 1);
    results.push(scenario + " rejected with correct shutdown recovery");
    continue;
  }
  await install();
  assert.equal(state.installs, 1);
  assert.equal(state.prepares, 1);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.disableDifferentialDownload, true);
  const forced = [];
  api.requestForceAutoUpdate((value) => forced.push(value));
  assert.equal(forced[0].kind, "error");
  results.push("verified Windows download and explicit install, stable manual policy");
}
await writeFile(
  resolve(root, "result.json"),
  JSON.stringify({ passed: results.length, results }, null, 2),
);
assert.equal(results.length, 12);
console.log(`MiloCode updater wiring smoke: ${results.length}/12 passed; ${root}`);
