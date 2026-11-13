/** 只登记既有静态呈现入口，不接管 Electron 窗口或任务生命周期。 */
export const cuaOperationIndicatorContentModule = {
  id: "cua-operation-indicator-content",
  requires: ["shared"],
  provides: ["cua-operation-indicator-content"],
  publicEntrypoints: [
    "packages/desktop/src/main/windowsCuaOperationIndicatorContent.ts",
    "packages/desktop/src/main/cua-operation-indicator-content/contract.ts",
  ],
} as const;
