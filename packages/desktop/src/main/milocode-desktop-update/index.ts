import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import { MILOCODE_SPARKLE_PUBLIC_KEY, MILOCODE_UPDATE_BASE_URL } from "@zcode/shared";
import type { MiloCodeMacUpdater, MiloCodeMacUpdaterOptions } from "./contract.js";
import type { MiloCodeSparkleNativeBridge } from "../../../scripts/milocode-sparkle-runtime.mjs";

export type { MiloCodeMacUpdater, MiloCodeMacUpdaterOptions } from "./contract.js";

export function createMiloCodeMacUpdater(options: MiloCodeMacUpdaterOptions): MiloCodeMacUpdater {
  if (
    !app.isPackaged ||
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !MILOCODE_UPDATE_BASE_URL ||
    !MILOCODE_SPARKLE_PUBLIC_KEY
  ) {
    throw new Error("MiloCode Mac updates require a configured arm64 release build");
  }
  const require = createRequire(import.meta.url);
  const native = require(
    join(process.resourcesPath, "milocode-update/milocode_sparkle.node"),
  ) as MiloCodeSparkleNativeBridge;
  let disposed = false;
  let activeRequest: string | null = null;
  let approvedRequest: string | null = null;
  let shutdownStarted = false;
  let recovering = false;
  let version: string | undefined;

  function recoverAfterShutdown() {
    if (!shutdownStarted || recovering || disposed) return;
    recovering = true;
    options.onInstallFailure();
  }

  async function admitInstallation(requestId: string) {
    if (disposed || activeRequest || approvedRequest === requestId) return;
    activeRequest = requestId;
    try {
      const allow = await options.confirmInstall();
      if (disposed || activeRequest !== requestId) return;
      if (!allow) {
        native.resolveInstall(requestId, false);
        return;
      }
      // 修复依据：原生安装 continuation 必须等唯一 Host/Agent 退出屏障完成后放行。
      shutdownStarted = true;
      await options.onBeforeInstall();
      if (disposed || activeRequest !== requestId) return;
      approvedRequest = requestId;
      native.resolveInstall(requestId, true);
    } catch {
      if (!disposed && activeRequest === requestId) {
        try {
          native.resolveInstall(requestId, false);
        } catch {
          /* 原生错误已结束该事务。 */
        }
      }
      recoverAfterShutdown();
    } finally {
      if (activeRequest === requestId) activeRequest = null;
    }
  }

  native.start((event) => {
    if (disposed) return;
    if (event.version) version = event.version;
    switch (event.kind) {
      case "checking":
        options.onState({ kind: "checking", enabled: true });
        break;
      case "update-available":
        if (version)
          options.onState({ kind: "update-available", enabled: true, version, channel: "stable" });
        break;
      case "downloading":
        options.onState({
          kind: "download-progress",
          enabled: true,
          progress: "",
          version,
          channel: "stable",
        });
        break;
      case "downloaded":
        if (version)
          options.onState({ kind: "update-downloaded", enabled: true, version, channel: "stable" });
        break;
      case "install-request":
        if (event.requestId) void admitInstallation(event.requestId);
        break;
      case "error":
        activeRequest = null;
        options.onState({ kind: "idle", enabled: true });
        recoverAfterShutdown();
        break;
      case "not-available":
        version = undefined;
        options.onState({ kind: "idle", enabled: true });
        break;
      case "idle":
        if (!activeRequest && !approvedRequest) options.onState({ kind: "idle", enabled: true });
        break;
    }
  });
  return {
    checkForUpdates() {
      if (!disposed && !shutdownStarted) native.checkForUpdates();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRequest = null;
      native.dispose();
    },
  };
}
