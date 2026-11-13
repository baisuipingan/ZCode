/** 根层提供一次上下文；workspace 内只读取本机账户，不随远端服务切换。 */
export const brandAccountUiContractExample = {
  root: "BrandAccountProvider",
  consumers: ["BrandAccountLogin", "BrandAccountSummary", "BrandAccountSection"],
  authority: "local Host brandAccountService",
  secretsInRenderer: false,
} as const;
