// 真实账号组件与样式；合成账户只在浏览器fixture中提供，不连接生产。
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@zcode/shared";
import type { BrandAccountSnapshot, BrandOrder, IBrandAccountService } from "@zcode/services";
import { BrandAccountSection } from "@/brand-account/BrandAccountSection.js";
import { BrandAccountSummary } from "@/brand-account/BrandAccountSummary.js";
import { BrandAccountContext } from "@/brand-account/context.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TabStoreProvider, useTabStore } from "@/store/TabStoreProvider.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const calls = {
  balance: 0,
  logout: 0,
  orders: 0,
  recharge: [] as Array<number | undefined>,
  browsers: [] as string[],
};
Object.assign(window, { __brandLayoutCalls: calls });
const platform = {
  openExternal: (url: string) => calls.browsers.push(url),
  executeDesktopCommand: async () => {},
} as unknown as IPlatformService;

function account(id = 1): BrandAccountSnapshot {
  return {
    status: params.has("signedOut") ? "signedOut" : "authenticated",
    accountEpoch: id,
    user: params.has("signedOut")
      ? null
      : {
          id,
          username: id === 1 ? "Milo workspace member with a long name" : "Second account",
          email: `member-${id}@example.invalid`,
        },
    challenge: null,
    error: null,
    browserLogin: { status: "idle", expiresAt: null },
    settings: {
      siteName: "MiloRouter",
      siteUrl: "https://fixture.example.test",
      registrationEnabled: true,
      passwordResetEnabled: true,
      turnstileEnabled: true,
      tencentCaptchaEnabled: false,
      aliyunCaptchaEnabled: false,
      paymentEnabled: true,
      paymentBalanceDisabled: false,
      billingCurrencyEnabled: false,
      billingEngine: "legacy",
      displayCurrency: "USD",
      usdToCny: 1,
    },
    wallet: {
      status: "fresh",
      availableUsd: id === 1 ? 12.34 : 67.89,
      frozenUsd: 2,
      fetchedAt: "2026-11-13T08:30:00Z",
      error: null,
    },
    inference: {
      status: "configured",
      error: null,
      refreshStatus: "idle",
      lastSuccessfulAt: 1794558600000,
      refreshError: null,
    },
    usage: {
      status: "fresh",
      fetchedAt: "2026-11-13T08:30:00Z",
      error: null,
      items: [
        {
          requestId: `usage-${id}`,
          model: "Example model with a long display name",
          createdAt: "2026-11-13T08:25:00Z",
          charge: {
            kind: "credits",
            credits: "123",
            creditsPerUsd: "10000",
            usdDecimal: "0.0123",
            precision: "exact",
          },
        },
      ],
    },
  };
}

function order(id: number): BrandOrder {
  return {
    id,
    outTradeNo: `fixture-order-account-${id}`,
    status: "COMPLETED",
    orderType: "balance",
    paymentType: "fixture",
    creditedUsd: 10,
    bonusUsd: 0,
    payAmount: 10,
    paymentCurrency: "USD",
    createdAt: "2026-11-13T08:20:00Z",
    expiresAt: null,
    paidAt: "2026-11-13T08:20:05Z",
    completedAt: "2026-11-13T08:20:10Z",
  };
}

function AccountView() {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-background text-foreground md:flex-row">
      <aside className="w-full shrink-0 bg-sidebar p-4 md:w-64">
        <BrandAccountSummary />
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <h2 className="text-ui-xl font-semibold">
            {intl.formatMessage({ id: "brandAccount.accountUsageTitle" })}
          </h2>
          <BrandAccountSection />
        </div>
      </main>
    </div>
  );
}

function Fixture() {
  const [snapshot, setSnapshot] = useState(account);
  const current = useRef(snapshot);
  current.current = snapshot;
  const service = useMemo(
    () =>
      ({
        listOrders: async () => {
          calls.orders += 1;
          const id = current.current.user?.id ?? 1;
          if (params.has("gateOrder") && id === 1) {
            await new Promise<void>((resolve) =>
              Object.assign(window, { __releaseBrandOrder: resolve }),
            );
          }
          return { items: [order(id)], total: 1, page: 1, pageSize: 20 };
        },
        startBrowserLogin: async () => {
          const expiresAt = Date.now() + 300000;
          setSnapshot((old) => ({
            ...old,
            browserLogin: { status: "waiting", expiresAt },
          }));
          return {
            authorizationUrl:
              "https://fixture.example.test/desktop/authorize?client_id=zcode-desktop",
            expiresAt,
          };
        },
        cancelBrowserLogin: async () => {
          setSnapshot((old) => ({
            ...old,
            browserLogin: { status: "idle", expiresAt: null },
          }));
          return current.current;
        },
        logout: async () => {
          calls.logout += 1;
          const next: BrandAccountSnapshot = {
            ...current.current,
            status: "signedOut",
            accountEpoch: current.current.accountEpoch + 1,
            user: null,
          };
          setSnapshot(next);
          return next;
        },
      }) as unknown as IBrandAccountService,
    [],
  );
  return (
    <PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale={locale}>
        <TabStoreProvider>
          <BrandAccountContext.Provider
            value={{
              enabled: true,
              service,
              snapshot,
              initializationFailed: false,
              initialize: async () => {},
              refreshAgentConfig: async () => {},
              refreshBalance: async () => {
                calls.balance += 1;
              },
              openRecharge: (id) => calls.recharge.push(id),
            }}
          >
            <AccountView />
            <NavigationState />
            <div className="flex flex-wrap gap-3 p-4 text-ui-caption">
              <button data-testid="fixture-switch-account" onClick={() => setSnapshot(account(2))}>
                Switch fixture account
              </button>
              <button
                data-testid="fixture-wallet-reauthenticate"
                onClick={() =>
                  setSnapshot((old) => ({
                    ...old,
                    wallet: {
                      ...old.wallet,
                      status: "stale",
                      error: { code: "reauthentication_required", message: "fixture" },
                    },
                  }))
                }
              >
                Require fixture reauthentication
              </button>
              <button
                data-testid="fixture-stale-wallet"
                onClick={() =>
                  setSnapshot((old) => ({
                    ...old,
                    wallet: {
                      ...old.wallet,
                      status: "stale",
                      error: { code: "network", message: "fixture" },
                    },
                  }))
                }
              >
                Make fixture wallet stale
              </button>
            </div>
          </BrandAccountContext.Provider>
        </TabStoreProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  );
}

function NavigationState() {
  const count = useTabStore((state) => state.tabs.length);
  return (
    <output hidden data-testid="fixture-settings-tabs">
      {count}
    </output>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
