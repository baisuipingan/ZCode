export const miloCodeSparkleNativeModule = {
  id: "milocode-sparkle-native",
  requires: [],
  provides: ["milocode-sparkle-native"],
  publicEntrypoints: [
    "packages/desktop/native/milocode-sparkle/contract.ts",
    "packages/desktop/scripts/milocode-sparkle-runtime.mjs",
  ],
} as const;
