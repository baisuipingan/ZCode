import type { BrandAccountSnapshot } from "./contract.js";
import { emptyWallet } from "./projections.js";
import { emptyBrandUsage } from "./usageReader.js";

/** 初始投影工厂，不持有或共享可变账户状态。 */
export function initialAccountSnapshot(): BrandAccountSnapshot {
  return {
    status: "initializing",
    accountEpoch: 0,
    user: null,
    wallet: emptyWallet(),
    settings: null,
    challenge: null,
    error: null,
    inference: {
      status: "signedOut",
      error: null,
      refreshStatus: "idle",
      lastSuccessfulAt: null,
      refreshError: null,
    },
    usage: emptyBrandUsage(),
    browserLogin: { status: "idle", expiresAt: null },
  };
}
