import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

// agent-desktop v1.3.1 官方 macOS 支持地板；不能沿用旧私有 Helper 的 12.0。
export const CUA_MINIMUM_MACOS_VERSION = "13.0";
const CUA_MINIMUM_DARWIN_MAJOR = 22; // Darwin 22 ↔ macOS 13

export function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
