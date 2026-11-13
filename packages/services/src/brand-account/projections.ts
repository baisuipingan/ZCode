import type { PrivateSession } from "./secretRepo.js";
import type {
  BrandAccountSnapshot,
  BrandAccountUser,
  BrandLoginInput,
  BrandCheckout,
  BrandCreateOrderResult,
  BrandOrder,
  BrandOrderPage,
  BrandPublicSettings,
} from "./contract.js";
import { failure } from "./errors.js";
import { number, positiveId, record, text } from "./httpClient.js";

export const emptyWallet = (): BrandAccountSnapshot["wallet"] => ({
  status: "unknown",
  availableUsd: null,
  frozenUsd: null,
  fetchedAt: null,
  error: null,
});

/** RPC只接收刷新意图；不接受客户端提供的目录、版本或成功时间。 */
export function agentRefreshForce(input: unknown): boolean {
  if (input === undefined) return false;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("invalid_input");
  const value = record(input);
  if (
    Object.keys(value).some((key) => key !== "force") ||
    (value.force !== undefined && typeof value.force !== "boolean")
  )
    throw failure("invalid_input");
  return value.force === true;
}

export function validateLoginInput(input: BrandLoginInput): void {
  if (
    !input ||
    !input.email?.trim() ||
    !input.password ||
    input.email.length > 320 ||
    input.password.length > 8192
  )
    throw failure("invalid_input");
}

/** 订单查询/投影无账户写入；账户服务继续拥有鉴权与到账后的余额读取顺序。 */
export function orderPageQuery(input?: { page?: number; pageSize?: number; status?: string }) {
  const page = input?.page ?? 1;
  const pageSize = input?.pageSize ?? 20;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (input?.status && !/^[A-Z_]{1,40}$/.test(input.status))
  )
    throw failure("invalid_input");
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    order_type: "balance",
  });
  if (input?.status) query.set("status", input.status);
  return { query, page, pageSize };
}

export function orderPage(
  value: unknown,
  fallback: { page: number; pageSize: number },
): BrandOrderPage {
  const raw = record(value);
  if (!Array.isArray(raw.items)) throw failure("invalid_response");
  return {
    items: raw.items.map((value) => order(value)),
    total: number(raw.total),
    page: number(raw.page, fallback.page),
    pageSize: number(raw.page_size, fallback.pageSize),
  };
}

export function publicSettings(value: unknown, origin: string): BrandPublicSettings {
  const raw = record(value);
  const currency = raw.billing_display_currency;
  if (currency !== "USD" && currency !== "CNY") throw failure("invalid_response");
  const rate = number(raw.billing_usd_to_cny);
  if (rate <= 0) throw failure("invalid_response");
  return {
    siteName: text(raw.site_name, "MiloRouter"),
    siteUrl: origin,
    registrationEnabled: raw.registration_enabled === true,
    passwordResetEnabled: raw.password_reset_enabled === true,
    turnstileEnabled: raw.turnstile_enabled === true,
    turnstileSiteKey: text(raw.turnstile_site_key) || undefined,
    tencentCaptchaEnabled: raw.tencent_captcha_enabled === true,
    tencentCaptchaAppId: text(raw.tencent_captcha_app_id) || undefined,
    aliyunCaptchaEnabled: raw.aliyun_captcha_enabled === true,
    paymentEnabled: raw.payment_enabled === true,
    paymentBalanceDisabled: raw.payment_balance_disabled === true,
    billingCurrencyEnabled: raw.billing_currency_enabled === true,
    billingEngine: text(raw.billing_engine),
    displayCurrency: raw.billing_currency_enabled === false ? "USD" : currency,
    usdToCny: rate,
    billingSettingsVersion:
      typeof raw.billing_settings_version === "number" &&
      Number.isSafeInteger(raw.billing_settings_version)
        ? String(raw.billing_settings_version)
        : undefined,
  };
}

export function accountUser(value: unknown): BrandAccountUser {
  const raw = record(value);
  return {
    id: positiveId(raw.id),
    email: text(raw.email),
    username: text(raw.username),
  };
}

export function checkout(configValue: unknown, infoValue?: unknown): BrandCheckout {
  const config = record(configValue);
  const info = infoValue === undefined ? {} : record(infoValue);
  const methods =
    config.enabled === true && config.balance_disabled !== true
      ? Object.entries(record(info.methods)).map(([key, value]) => {
          const raw = record(value);
          return {
            paymentType: text(raw.payment_type, key),
            displayName: text(raw.display_name, key),
            currency: text(raw.currency),
            feeRate: number(raw.fee_rate),
            singleMin: number(raw.single_min),
            singleMax: number(raw.single_max),
            dailyLimit: number(raw.daily_limit),
          };
        })
      : [];
  if (methods.some((method) => !/^[A-Z]{3}$/.test(method.currency)))
    throw failure("invalid_response");
  return {
    enabled: config.enabled === true,
    balanceDisabled: config.balance_disabled === true,
    methods,
    minAmount: number(config.min_amount, 0),
    maxAmount: number(config.max_amount, 0),
    orderTimeoutMinutes: number(config.order_timeout_minutes, 30),
    helpText: text(config.help_text),
    quoteNotice: "",
  };
}

function nullableDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw failure("invalid_response");
  return value;
}

export function order(value: unknown, creation = false): BrandOrder {
  const raw = record(value);
  const currency = text(raw.currency);
  if (!/^[A-Z]{3}$/.test(currency)) throw failure("invalid_response");
  const status = text(raw.status);
  const tradeNo = text(raw.out_trade_no);
  if (!status || !tradeNo || tradeNo.length > 256) throw failure("invalid_response");
  return {
    id: positiveId(creation ? raw.order_id : raw.id),
    outTradeNo: tradeNo,
    status,
    orderType: text(raw.order_type, creation ? "balance" : ""),
    paymentType: text(raw.payment_type),
    creditedUsd: number(raw.amount),
    bonusUsd: number(raw.bonus_amount, 0),
    payAmount: number(raw.pay_amount),
    paymentCurrency: currency,
    createdAt: nullableDate(raw.created_at) ?? "",
    expiresAt: nullableDate(raw.expires_at),
    paidAt: nullableDate(raw.paid_at),
    completedAt: nullableDate(raw.completed_at),
  };
}

function paymentUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    // 拒绝将账号JWT等材料通过支付链接交给浏览器。
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(access_token|refresh_token|authorization|jwt)$/i.test(key),
      )
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function createOrderProjection(
  value: unknown,
  authoritativeOrder?: BrandOrder,
): BrandCreateOrderResult {
  const raw = record(value);
  const resultType = text(raw.result_type);
  if (resultType === "oauth_required") return { kind: "unsupported", reason: "oauth", order: null };
  const projected =
    authoritativeOrder ??
    (typeof raw.order_id === "number" && raw.order_id > 0 ? order(raw, true) : null);
  if (resultType === "jsapi_ready" || raw.jsapi || raw.jsapi_payload)
    return { kind: "unsupported", reason: "jsapi", order: projected };
  if (raw.client_secret || raw.intent_id)
    return { kind: "unsupported", reason: "provider_sdk", order: projected };
  if (!projected) throw failure("invalid_response");
  const payUrl = paymentUrl(raw.pay_url);
  const qrCode =
    typeof raw.qr_code === "string" && raw.qr_code.length <= 32768 ? raw.qr_code : null;
  if (!payUrl && !qrCode)
    return {
      kind: "unsupported",
      reason: "no_payment_action",
      order: projected,
    };
  return { kind: "payment", order: projected, payUrl, qrCode };
}

export function validateOrderInput(input: { amount: number; paymentType: string }): void {
  if (
    !input ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0 ||
    typeof input.paymentType !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.paymentType)
  )
    throw failure("invalid_input");
}

export function balanceOrderRequest(input: { amount: number; paymentType: string }) {
  return {
    amount: input.amount,
    payment_type: input.paymentType,
    order_type: "balance",
    payment_source: "hosted_redirect",
    is_mobile: false,
  };
}

export function validateOrderMethod(
  input: { amount: number; paymentType: string },
  available: BrandCheckout,
): void {
  const method = available.methods.find((item) => item.paymentType === input.paymentType);
  if (!available.enabled || available.balanceDisabled || !method)
    throw failure("payment_unavailable");
  if (
    (method.singleMin > 0 && input.amount < method.singleMin) ||
    (method.singleMax > 0 && input.amount > method.singleMax)
  )
    throw failure("invalid_input");
}

/** 身份投影不拥有会话状态；调用者传入同步IO屏障。 */
export function privateSessionIdentity(session: PrivateSession, origin: string, blocked: boolean) {
  if (blocked) throw failure("session_changed");
  if (!session.credentials) throw failure("unauthenticated");
  if (session.refreshUncertain) throw failure("reauthentication_required");
  return { origin, accountRef: String(session.credentials.userId), accountEpoch: session.epoch };
}
