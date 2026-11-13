import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@zcode/shared";
import type {
  IBrandAccountService,
  BrandAccountSnapshot,
  BrandAccountErrorCode,
} from "@zcode/services";
import { BrandAccountLogin } from "@/brand-account/BrandAccountLogin.js";
import { BrandInferenceStatus } from "@/brand-account/BrandInferenceStatus.js";
import { BrandModelSyncStatus } from "@/brand-account/BrandModelSyncStatus.js";
import { BrandAccountContext } from "@/brand-account/context.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider, useTabStore } from "@/store/TabStoreProvider.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const captured: string[] = [];
const actions: string[] = [];
Object.assign(window, { __browserLoginOpened: captured, __brandInferenceActions: actions });
const inferenceSurface = params.get("surface");
const accountStatus = params.get("accountStatus") as BrandAccountSnapshot["status"] | null;
const inferenceError = params.has("reason")
  ? { code: params.get("reason") as BrandAccountErrorCode, message: "UNTRUSTED_INTERNAL_SECRET" }
  : null;
const platform = {
  openExternal: (url: string) => {
    captured.push(url);
    if (params.has("failOpen")) throw new Error("fixture browser unavailable");
  },
  executeDesktopCommand: async () => {},
} as unknown as IPlatformService;

function Fixture() {
  const [initializationFailed, setInitializationFailed] = useState(
    params.has("initializationError"),
  );
  const [snapshot, setSnapshot] = useState<BrandAccountSnapshot>({
    status: accountStatus ?? (inferenceSurface ? "authenticated" : "signedOut"),
    accountEpoch: 1,
    user: inferenceSurface ? { id: 1, username: "Fixture", email: "fixture@example.test" } : null,
    challenge: null,
    error: params.has("initializationError")
      ? { code: "storage_unavailable", message: "UNTRUSTED_INTERNAL_SECRET" }
      : null,
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
      status: "unknown",
      availableUsd: null,
      frozenUsd: null,
      fetchedAt: null,
      error: null,
    },
    inference: {
      status:
        inferenceSurface === "sync" ? "configured" : inferenceSurface ? "unavailable" : "signedOut",
      error: inferenceSurface === "status" ? inferenceError : null,
      refreshStatus: "idle",
      lastSuccessfulAt: inferenceSurface === "sync" ? 1794500000000 : null,
      refreshError: inferenceSurface === "sync" ? inferenceError : null,
    },
    usage: { status: "unknown", items: [], fetchedAt: null, error: null },
  });
  const service = {
    logout: async () => {
      actions.push("logout");
      setSnapshot((old) => ({
        ...old,
        status: "signedOut",
        accountEpoch: old.accountEpoch + 1,
        user: null,
      }));
      return snapshot;
    },
    startBrowserLogin: async () => {
      if (params.has("failStorage")) {
        setSnapshot((old) => ({
          ...old,
          error: { code: "storage_unavailable", message: "UNTRUSTED_INTERNAL_SECRET" },
        }));
        setInitializationFailed(true);
        throw { code: "storage_unavailable", message: "UNTRUSTED_INTERNAL_SECRET" };
      }
      const expiresAt = Date.now() + 300000;
      setSnapshot((old) => ({ ...old, browserLogin: { status: "waiting", expiresAt } }));
      return {
        authorizationUrl: "https://fixture.example.test/desktop/authorize?client_id=zcode-desktop",
        expiresAt,
      };
    },
    cancelBrowserLogin: async () => {
      setSnapshot((old) => ({ ...old, browserLogin: { status: "idle", expiresAt: null } }));
      return snapshot;
    },
  } as unknown as IBrandAccountService;
  return (
    <PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale={locale}>
        <TabStoreProvider>
          <BrandAccountContext.Provider
            value={{
              enabled: true,
              service,
              snapshot,
              initializationFailed,
              initialize: async () => {
                actions.push("initialize");
              },
              refreshBalance: async () => {},
              refreshAgentConfig: async () => {
                actions.push("refresh");
              },
              openRecharge: () => {},
            }}
          >
            {inferenceSurface ? (
              <div className="mx-auto max-w-sm p-4">
                {inferenceSurface === "sync" ? <BrandModelSyncStatus /> : <BrandInferenceStatus />}
              </div>
            ) : (
              <BrandAccountLogin variant={params.has("embedded") ? "embedded" : "standalone"} />
            )}
          </BrandAccountContext.Provider>
          <NavigationState />
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
