import type { BrandPaymentActions } from "./paymentContract.js";
export type {
  BrandPaymentMethod,
  BrandCheckout,
  BrandOrder,
  BrandOrderPage,
  BrandCreateOrderResult,
} from "./paymentContract.js";
import type { Event } from "@zcode/rpc";
import { createServiceDescriptor } from "#src/descriptors.js";

export type BrandAccountErrorCode =
  | "network"
  | "timeout"
  | "unauthenticated"
  | "reauthentication_required"
  | "invalid_credentials"
  | "captcha_required"
  | "invalid_two_factor"
  | "rate_limited"
  | "storage_unavailable"
  | "busy"
  | "browser_login_cancelled"
  | "browser_login_expired"
  | "invalid_response"
  | "invalid_input"
  | "payment_unavailable"
  | "inference_unavailable"
  | "service_disabled"
  | "service_not_configured"
  | "account_forbidden"
  | "group_unavailable"
  | "group_forbidden"
  | "credential_disabled"
  | "credential_expired"
  | "credential_quota_exhausted"
  | "configuration_invalid"
  | "model_unavailable"
  | "model_configuration_changed"
  | "request_rejected"
  | "session_changed";

export interface BrandAccountError {
  code: BrandAccountErrorCode;
  message: string;
}

export interface BrandPublicSettings {
  siteName: string;
  siteUrl: string;
  registrationEnabled: boolean;
  passwordResetEnabled: boolean;
  turnstileEnabled: boolean;
  turnstileSiteKey?: string;
  tencentCaptchaEnabled: boolean;
  tencentCaptchaAppId?: string;
  aliyunCaptchaEnabled: boolean;
  paymentEnabled: boolean;
  paymentBalanceDisabled: boolean;
  billingCurrencyEnabled: boolean;
  billingEngine: string;
  displayCurrency: "USD" | "CNY";
  usdToCny: number;
  billingSettingsVersion?: string;
}

export interface BrandAccountUser {
  id: number;
  email: string;
  username: string;
}

export interface BrandWalletSnapshot {
  status: "unknown" | "syncing" | "fresh" | "stale" | "unavailable";
  /** 服务端 balance 已为可用 USD 等价余额；不重复扣除冻结金额。 */
  availableUsd: number | null;
  frozenUsd: number | null;
  fetchedAt: string | null;
  error: BrandAccountError | null;
}

export interface BrandAccountSnapshot {
  status: "initializing" | "signedOut" | "twoFactor" | "authenticated" | "expired";
  accountEpoch: number;
  user: BrandAccountUser | null;
  wallet: BrandWalletSnapshot;
  settings: BrandPublicSettings | null;
  /** 2FA 临时凭据仅保存在 Host 内存。 */
  challenge: { emailMasked: string } | null;
  error: BrandAccountError | null;
  /** configured 为Host策略就绪；每个目标CLI执行前仍须确认Registry已应用。 */
  inference: BrandInferenceSnapshot;
  usage: BrandUsageSnapshot;
  /** Host 持有浏览器授权；URL/state/verifier/code 不进入广播快照。 */
  browserLogin: { status: "idle" | "waiting"; expiresAt: number | null };
}

export interface BrandUsageRecord {
  requestId: string;
  model: string;
  createdAt: string;
  charge:
    | {
        kind: "credits";
        credits: string;
        creditsPerUsd: string;
        usdDecimal: string;
        precision: "exact" | "approximate" | "lessThan";
      }
    | { kind: "legacy"; actualCostUsd: number }
    | { kind: "unavailable" };
}

export interface BrandUsageSnapshot {
  status: "unknown" | "syncing" | "fresh" | "stale" | "unavailable";
  items: BrandUsageRecord[];
  fetchedAt: string | null;
  error: BrandAccountError | null;
}

export interface BrandInferenceSnapshot {
  status: "signedOut" | "connecting" | "configured" | "unavailable";
  error: BrandAccountError | null;
  refreshStatus: "idle" | "refreshing";
  lastSuccessfulAt: number | null;
  refreshError: BrandAccountError | null;
}

export interface BrandLoginInput {
  email: string;
  password: string;
  turnstileToken?: string;
  tencentCaptchaTicket?: string;
  tencentCaptchaRandstr?: string;
}

export interface IBrandAccountService extends BrandPaymentActions {
  getSnapshot(): Promise<BrandAccountSnapshot>;
  initialize(): Promise<BrandAccountSnapshot>;
  refreshBalance(): Promise<BrandAccountSnapshot>;
  refreshAgentConfig(options?: { force?: boolean }): Promise<BrandAccountSnapshot>;
  startBrowserLogin(): Promise<{ authorizationUrl: string; expiresAt: number }>;
  cancelBrowserLogin(): Promise<BrandAccountSnapshot>;
  login(input: BrandLoginInput): Promise<BrandAccountSnapshot>;
  completeTwoFactor(code: string): Promise<BrandAccountSnapshot>;
  logout(): Promise<BrandAccountSnapshot>;
  onDidChange: Event<BrandAccountSnapshot>;
}

export const IBrandAccountService = createServiceDescriptor<IBrandAccountService>("brandAccount");
