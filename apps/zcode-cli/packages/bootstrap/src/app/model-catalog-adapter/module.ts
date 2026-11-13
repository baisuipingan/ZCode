/** 仅管理既有模型目录投影及其契约，不纳管整个 bootstrap app。 */
export const cliModelCatalogAdapterModule = {
  id: "cli-model-catalog-adapter",
  requires: ["provider", "shared", "zcode-cli"],
  provides: ["model-catalog-port-adapter"],
  publicEntrypoints: ["contract.ts", "../model-catalog-port.ts"],
} as const;
