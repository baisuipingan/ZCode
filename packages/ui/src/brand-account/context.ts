import { createContext, useContext } from "react";
import type { BrandAccountSnapshot, IBrandAccountService } from "./contract.js";

export interface BrandAccountContextValue {
  enabled: boolean;
  service: IBrandAccountService | null;
  snapshot: BrandAccountSnapshot | null;
  initializationFailed: boolean;
  initialize(): Promise<void>;
  refreshBalance(): Promise<void>;
  refreshAgentConfig(options?: { force?: boolean }): Promise<void>;
  openRecharge(orderId?: number): void;
}

export const BrandAccountContext = createContext<BrandAccountContextValue | null>(null);

export function useBrandAccount(): BrandAccountContextValue {
  return (
    useContext(BrandAccountContext) ?? {
      enabled: false,
      service: null,
      snapshot: null,
      initializationFailed: false,
      initialize: async () => {},
      refreshBalance: async () => {},
      refreshAgentConfig: async () => {},
      openRecharge: () => {},
    }
  );
}
