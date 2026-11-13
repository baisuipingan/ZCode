import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BrandAccountSnapshot, IBrandAccountService } from "./contract.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { BrandAccountContext } from "./context.js";
import { BrandRechargeDialog } from "./BrandRechargeDialog.js";

/** 钱包只消费根本机 Host；远端 workspace 的 ServiceProvider 不拥有本机登录。 */
export function BrandAccountProvider({ children }: { children: ReactNode }) {
  const baseServices = useOptionalBaseWorkspaceServices();
  const service = baseServices?.brandAccountService ?? null;
  const [owned, setOwned] = useState<{
    service: IBrandAccountService;
    snapshot: BrandAccountSnapshot;
  } | null>(null);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [recharge, setRecharge] = useState<{ orderId?: number } | null>(null);
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const snapshot = owned?.service === service ? owned.snapshot : null;

  const accept = useCallback(
    (next: BrandAccountSnapshot) => {
      if (!service || serviceRef.current !== service) return;
      setOwned((current) => {
        // 换号后迟到的旧窗口/请求不能重新展示前一账号的钱包。
        if (current?.service === service && next.accountEpoch < current.snapshot.accountEpoch)
          return current;
        return { service, snapshot: next };
      });
    },
    [service],
  );
  const initialize = useCallback(async () => {
    if (!service) return;
    setInitializationFailed(false);
    try {
      const next = await service.initialize();
      accept(next);
      if (serviceRef.current === service && !next.settings && next.error)
        setInitializationFailed(true);
    } catch {
      if (serviceRef.current === service) setInitializationFailed(true);
    }
  }, [accept, service]);
  const refreshBalance = useCallback(async () => {
    if (!service) return;
    accept(await service.refreshBalance());
  }, [accept, service]);
  const refreshAgentConfig = useCallback(
    async (options?: { force?: boolean }) => {
      if (!service) return;
      accept(await service.refreshAgentConfig(options));
    },
    [accept, service],
  );

  useEffect(() => {
    if (!service) return;
    let active = true;
    const subscription = service.onDidChange((next) => {
      if (active) accept(next);
    });
    void initialize();
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [accept, initialize, service]);
  useEffect(() => {
    setRecharge(null);
  }, [snapshot?.accountEpoch]);
  useEffect(() => {
    if (snapshot?.status !== "authenticated") return;
    const refresh = () => {
      void refreshBalance().catch(() => {});
      void refreshAgentConfig({ force: false }).catch(() => {});
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    // 只发送前台刷新意图；新鲜度与并发去重属于 Host，不能在 UI 复制第二份时钟。
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void refreshAgentConfig({ force: false }).catch(() => {});
    }, 5 * 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", visible);
      window.clearInterval(timer);
    };
  }, [refreshAgentConfig, refreshBalance, snapshot?.status]);

  const openRecharge = useCallback((orderId?: number) => setRecharge({ orderId }), []);
  return (
    <BrandAccountContext.Provider
      value={{
        enabled: Boolean(service),
        service,
        snapshot,
        initializationFailed,
        initialize,
        refreshBalance,
        refreshAgentConfig,
        openRecharge,
      }}
    >
      {children}
      {recharge && snapshot?.status === "authenticated" ? (
        <BrandRechargeDialog
          key={snapshot.accountEpoch}
          initialOrderId={recharge.orderId}
          onClose={() => setRecharge(null)}
        />
      ) : null}
    </BrandAccountContext.Provider>
  );
}
