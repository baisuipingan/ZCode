import type { BrandAccountSnapshot, BrandAccountErrorCode } from "./contract.js";

export function brandErrorMessageId(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const known: Partial<Record<BrandAccountErrorCode, string>> = {
    invalid_credentials: "credentials",
    reauthentication_required: "reauth",
    invalid_two_factor: "twoFactor",
    captcha_required: "captcha",
    unauthenticated: "expired",
    rate_limited: "rateLimit",
    busy: "busy",
    browser_login_cancelled: "browserCancelled",
    browser_login_expired: "browserExpired",
    session_changed: "changed",
    payment_unavailable: "payment",
    invalid_input: "input",
    storage_unavailable: "storage",
    network: "network",
    timeout: "network",
    service_disabled: "serviceDisabled",
    service_not_configured: "serviceNotConfigured",
    account_forbidden: "accountForbidden",
    group_unavailable: "groupUnavailable",
    group_forbidden: "groupForbidden",
    credential_disabled: "credentialDisabled",
    credential_expired: "credentialExpired",
    credential_quota_exhausted: "credentialQuota",
    configuration_invalid: "configurationInvalid",
    inference_unavailable: "inferenceUnavailable",
    model_unavailable: "modelUnavailable",
    model_configuration_changed: "modelConfigurationChanged",
  };
  // 未知错误码也可能是 constructor 等原型键，只允许自身白名单字段进入国际化 ID。
  const suffix =
    typeof code === "string" && Object.hasOwn(known, code)
      ? known[code as BrandAccountErrorCode]
      : "generic";
  return `brandAccount.error.${suffix}`;
}

/** 停用/配额等管理状态无法靠重登或刷新解除；只消费 Host 白名单错误码。 */
export function brandInferenceRecoveryAction(
  error: unknown,
): "refresh" | "reauthenticate" | "none" {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "reauthentication_required" || code === "unauthenticated") return "reauthenticate";
  if (
    typeof code === "string" &&
    [
      "service_disabled",
      "service_not_configured",
      "account_forbidden",
      "group_unavailable",
      "group_forbidden",
      "credential_disabled",
      "credential_expired",
      "credential_quota_exhausted",
      "configuration_invalid",
    ].includes(code)
  )
    return "none";
  return "refresh";
}

export function formatBrandBalance(
  snapshot: BrandAccountSnapshot | null,
  locale: string,
  usd: number | null,
): string {
  if (usd === null) return "—";
  const currency = snapshot?.settings?.displayCurrency ?? "USD";
  const rate = currency === "CNY" ? (snapshot?.settings?.usdToCny ?? 1) : 1;
  return formatBrandMoney(usd * rate, currency, locale);
}

export function formatBrandMoney(value: number, currency: string, locale: string): string {
  const options = {
    minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 4 : 2,
  };
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      ...options,
    }).format(value);
  } catch {
    return `${currency} ${new Intl.NumberFormat(locale, options).format(value)}`;
  }
}

export function brandWebsiteUrl(siteUrl: string | undefined, path: string): string | null {
  try {
    const base = new URL(siteUrl ?? "");
    if (base.protocol !== "https:" || base.username || base.password) return null;
    return new URL(path, base.origin).toString();
  } catch {
    return null;
  }
}

export function isPendingBrandOrder(status: string): boolean {
  return ["PENDING", "PAID", "RECHARGING"].includes(status.toUpperCase());
}

export function brandOrderStatusId(status: string): string {
  const value = status.toUpperCase();
  return `brandAccount.order.${["PENDING", "PAID", "RECHARGING", "COMPLETED", "EXPIRED", "CANCELLED", "FAILED", "REFUNDED", "REFUNDING", "PARTIALLY_REFUNDED"].includes(value) ? value : "UNKNOWN"}`;
}
