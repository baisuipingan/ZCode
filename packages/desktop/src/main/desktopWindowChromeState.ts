import { release as readPlatformRelease } from "node:os";
import { join } from "node:path";
import type { DesktopWindowChromeState } from "@zcode/shared";

const WINDOWS_11_FIRST_BUILD = 22000;

export function resolveDesktopAppIconPath(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  mainDirectory: string;
}): string {
  // Mac 满画布白底图会占满 Dock；平台专用资源已在构建时留边，所有系统入口必须读取同一份。
  // 只解析路径，不在运行时重新缩放，也不改变 Linux 和客户端内部 Logo 使用的通用资源。
  const filename =
    options.platform === "darwin"
      ? "icon_mac.png"
      : options.platform === "win32"
        ? "icon_windows.png"
        : "icon.png";
  return options.isPackaged
    ? join(options.resourcesPath, filename)
    : join(options.mainDirectory, "../../build", filename);
}

export function resolveMacOSMajorVersion(
  platform: NodeJS.Platform,
  platformRelease: string,
): number | null {
  if (platform !== "darwin") return null;

  const darwinMajor = Number.parseInt(platformRelease.split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwinMajor)) return null;

  // Tahoe 起产品版本从 15 跳到 26，不能继续套用旧的 Darwin - 9 映射。
  return darwinMajor >= 25 ? darwinMajor + 1 : darwinMajor - 9;
}

export function supportsNativeWindowsRoundedCorners(
  platform: NodeJS.Platform,
  platformRelease: string,
): boolean {
  if (platform !== "win32") return false;

  const build = Number.parseInt(platformRelease.split(".")[2] ?? "", 10);
  return Number.isFinite(build) && build >= WINDOWS_11_FIRST_BUILD;
}

export function resolveDesktopWindowChromeState(
  isMaximized: boolean,
  platform: NodeJS.Platform = process.platform,
  platformRelease: string = readPlatformRelease(),
): DesktopWindowChromeState {
  return {
    isMaximized,
    macOSMajorVersion: resolveMacOSMajorVersion(platform, platformRelease),
    supportsNativeRoundedCorners: supportsNativeWindowsRoundedCorners(platform, platformRelease),
  };
}
