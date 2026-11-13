import { failure } from "./errors.js";

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("invalid_response");
  return value as JsonRecord;
}

export function number(value: unknown, fallback?: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw failure("invalid_response");
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function positiveId(value: unknown): number {
  const id = number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw failure("invalid_response");
  return id;
}

export function createAccountHttpClient(baseUrl: string, fetchImpl: typeof globalThis.fetch) {
  let origin: string;
  try {
    const url = new URL(baseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw failure("invalid_input");
    origin = url.origin;
  } catch {
    throw failure("invalid_input");
  }
  const pending = new Set<AbortController>();
  let disposed = false;

  async function request(
    path: string,
    input?: { token?: string; body?: unknown; context?: "login" | "twoFactor" },
  ): Promise<unknown> {
    if (disposed) throw failure("network");
    const controller = new AbortController();
    pending.add(controller);
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(`${origin}/api/v1${path}`, {
        method: input?.body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          // 同一UA跨窗口/刷新保持稳定，避免session binding把原生Host当成新客户端。
          "User-Agent": "MiloRouter-Desktop/1.0",
          ...(input?.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
        body: input?.body === undefined ? undefined : JSON.stringify(input.body),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      // 拒绝超大或非JSON响应；不把原始HTML/服务端message带入RPC错误。
      const raw = await response.text();
      if (raw.length > 2_000_000) throw failure("invalid_response");
      let envelope: JsonRecord = {};
      try {
        envelope = record(JSON.parse(raw));
      } catch {
        /* 下方按HTTP状态映射安全错误。 */
      }
      if (!response.ok || envelope.code !== 0) {
        const metadata =
          envelope.metadata && typeof envelope.metadata === "object"
            ? (envelope.metadata as JsonRecord)
            : {};
        const reason = text(envelope.reason, text(metadata.reason)).toUpperCase();
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get("retry-after");
          const milliseconds =
            retry === null
              ? 0
              : /^\d+$/.test(retry)
                ? Number(retry) * 1000
                : Date.parse(retry) - Date.now();
          throw failure(
            response.status === 429 ? "rate_limited" : "request_rejected",
            Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined,
          );
        }
        if (reason.includes("CAPTCHA") || reason.includes("TURNSTILE"))
          throw failure("captcha_required");
        if (input?.context === "twoFactor") throw failure("invalid_two_factor");
        if (response.status === 401)
          throw failure(input?.context === "login" ? "invalid_credentials" : "unauthenticated");
        if (response.ok && envelope.code === undefined) throw failure("invalid_response");
        throw failure("request_rejected");
      }
      return envelope.data;
    } catch (error) {
      if (controller.signal.aborted) throw failure("timeout");
      if (error instanceof Error && error.name === "BrandAccountError") throw error;
      throw failure("network");
    } finally {
      clearTimeout(deadline);
      pending.delete(controller);
    }
  }

  return {
    origin,
    request,
    dispose: () => {
      disposed = true;
      for (const controller of pending) controller.abort();
      pending.clear();
    },
  };
}
