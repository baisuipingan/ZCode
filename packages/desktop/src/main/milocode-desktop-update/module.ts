export const miloCodeDesktopUpdateModule = {
  id: "milocode-desktop-update",
  requires: ["shared", "milocode-sparkle-native"],
  provides: ["milocode-desktop-update"],
  publicEntrypoints: [
    "packages/desktop/src/main/milocode-desktop-update/index.ts",
    "packages/desktop/src/main/milocode-desktop-update/contract.ts",
  ],
} as const;
