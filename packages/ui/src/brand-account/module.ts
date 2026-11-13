/** 本机品牌账户展示；账户、凭据、余额及订单事实由 Host 服务唯一持有。 */
export const brandAccountUiModule = {
  id: "brand-account-ui",
  requires: ["ui", "brand-account", "shared", "services"],
  provides: ["brand-account-ui"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
