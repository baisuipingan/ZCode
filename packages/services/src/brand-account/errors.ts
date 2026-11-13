import type { BrandAccountError, BrandAccountErrorCode } from "./contract.js";

const messages: Record<BrandAccountErrorCode, string> = {
  network: "网络连接失败，请重试。",
  timeout: "请求超时，请重试；若登录恢复失败，请重新登录。",
  unauthenticated: "登录已过期，请重新登录。",
  reauthentication_required: "登录恢复未完成，请退出后重新登录。",
  invalid_credentials: "邮箱或密码不正确。",
  captcha_required: "此账号登录需要网页安全验证，请联系支持。",
  invalid_two_factor: "动态验证码无效或已过期。",
  rate_limited: "请求过于频繁，请稍后重试。",
  storage_unavailable: "系统安全存储暂不可用，无法保存登录。",
  busy: "其他窗口正在更新账号，请稍后重试。",
  browser_login_cancelled: "本次浏览器授权已取消，请重新登录。",
  browser_login_expired: "本次浏览器授权已过期，请重新登录。",
  invalid_response: "服务返回的数据暂不可用，请重试。",
  invalid_input: "请检查输入的信息。",
  payment_unavailable: "充值暂未开放或此支付方式不可用。",
  inference_unavailable: "Agent服务暂不可用，请重新连接或联系支持。",
  service_disabled: "Agent服务已停用，请联系管理员。",
  service_not_configured: "Agent服务尚未配置，请联系管理员。",
  account_forbidden: "当前账号暂不能使用Agent服务，请联系管理员。",
  group_unavailable: "Agent服务分组暂不可用，请联系管理员。",
  group_forbidden: "当前账号没有Agent服务分组的访问权限，请联系管理员。",
  credential_disabled: "Agent访问凭据已停用，需要管理员恢复；重新登录不会解除停用。",
  credential_expired: "Agent访问凭据已过期，请联系管理员；重置密钥不会延长有效期。",
  credential_quota_exhausted: "Agent访问凭据的额度已用完，请联系管理员；重置密钥不会补充额度。",
  configuration_invalid: "Agent服务配置需要管理员修正。",
  model_unavailable: "该模型当前未为 Agent 开放，请选择其他模型后继续。",
  model_configuration_changed: "该模型的能力或参数已更新，请重新选择模型后继续。",
  request_rejected: "服务暂时无法完成请求，请稍后重试。",
  session_changed: "账号已在其他窗口更改，请重试。",
};

export function blocksInference(code: BrandAccountErrorCode): boolean {
  return [
    "inference_unavailable",
    "unauthenticated",
    "reauthentication_required",
    "service_disabled",
    "service_not_configured",
    "account_forbidden",
    "group_unavailable",
    "group_forbidden",
    "credential_disabled",
    "credential_expired",
    "credential_quota_exhausted",
    "configuration_invalid",
  ].includes(code);
}

export class AccountFailure extends Error {
  readonly code: BrandAccountErrorCode;
  constructor(
    code: BrandAccountErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(messages[code]);
    this.name = "BrandAccountError";
    this.code = code;
  }
}

export function failure(code: BrandAccountErrorCode, retryAfterMs?: number): AccountFailure {
  return new AccountFailure(code, retryAfterMs);
}

export function safeFailure(error: unknown): AccountFailure {
  return error instanceof AccountFailure ? error : failure("request_rejected");
}

export function errorProjection(error: unknown): BrandAccountError {
  const safe = safeFailure(error);
  return { code: safe.code, message: safe.message };
}
