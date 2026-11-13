export const miloCodeUpdateTrustModule = {
  id: "milocode-update-trust",
  requires: [],
  provides: ["milocode-update-trust"],
  publicEntrypoints: [
    "packages/desktop/src/main/milocode-update-trust/index.ts",
    "packages/desktop/src/main/milocode-update-trust/contract.ts",
    "packages/desktop/scripts/milocode-release-trust.mjs",
  ],
} as const;
