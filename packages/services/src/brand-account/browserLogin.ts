import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { failure, safeFailure } from "./errors.js";
import type { BrandAccountErrorCode } from "./contract.js";

const LOGIN_WINDOW_MS = 5 * 60_000;
const CALLBACK_PATH = "/callback";
type LoginLink = { authorizationUrl: string; expiresAt: number };
type Attempt<T> = {
  server: Server;
  owner: T;
  verifier: string;
  state: string;
  redirectUri: string;
  link: LoginLink;
  timer: ReturnType<typeof setTimeout>;
  consumed: boolean;
};

/** 一次浏览器授权的本机 owner；不会把 verifier/code 暴露给 RPC 或日志。 */
export function createBrowserLogin<T>(options: {
  origin: string;
  begin: () => Promise<T>;
  complete: (
    owner: T,
    body: { code: string; code_verifier: string; redirect_uri: string },
  ) => Promise<void>;
  waiting: (expiresAt: number | null, error?: BrandAccountErrorCode) => void;
}) {
  let attempt: Attempt<T> | null = null;
  let starting: Promise<LoginLink> | null = null;
  let generation = 0;
  let disposed = false;

  function close(current: Attempt<T>) {
    clearTimeout(current.timer);
    current.server.close();
    current.server.closeAllConnections();
  }
  function cancel(error?: BrandAccountErrorCode) {
    generation += 1;
    const current = attempt;
    attempt = null;
    starting = null;
    if (current) close(current);
    options.waiting(null, error);
  }
  function reply(
    response: ServerResponse,
    status: number,
    message: string,
    kind: "received" | "cancelled" | "error" = "error",
  ) {
    const title = { received: "授权已接收", cancelled: "已取消登录", error: "无法完成授权" }[kind];
    const nonce = randomBytes(18).toString("base64");
    const safeMessage = message.replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    );
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      Connection: "close",
    });
    // 原因：回调响应早于最终换证，只展示接收/取消/失败；不把授权参数或原始错误放进页面。
    response.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · MiloCode</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--page:#f9fafb;--card:#fff;--border:#e5e7eb;--text:#111827;--muted:#4b5563;--brand:#2563eb;--brand-bg:#eff6ff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:var(--page);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:480px;padding:32px;border:1px solid var(--border);border-radius:16px;background:var(--card)}
.brand{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:650}
.brand svg{width:32px;height:32px;padding:6px;border-radius:8px;background:var(--brand-bg);color:var(--brand)}
h1{margin:28px 0 12px;font-size:24px;line-height:1.35;letter-spacing:-.025em}
p{margin:0;color:var(--muted);font-size:15px;line-height:1.8;overflow-wrap:anywhere}
footer{margin-top:28px;padding-top:20px;border-top:1px solid var(--border);color:var(--muted);font-size:12px;line-height:1.7}
@media(prefers-color-scheme:dark){:root{--page:#0d0f13;--card:#181b21;--border:#3b404a;--text:#f9fafb;--muted:#b3b9c4;--brand:#60a5fa;--brand-bg:#172b4d}}
@media(max-width:420px){main{padding:24px}h1{font-size:22px}}
</style>
</head>
<body>
<main aria-labelledby="callback-title">
<div class="brand"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9 3 3-3 3m6 0h4"/></svg><span>MiloCode</span></div>
<h1 id="callback-title">${title}</h1>
<p>${safeMessage}</p>
<footer>此页面由你电脑上的 MiloCode 提供。</footer>
</main>
</body>
</html>`);
  }
  function afterReply(response: ServerResponse, action: () => void) {
    let handled = false;
    const run = () => {
      if (handled) return;
      handled = true;
      action();
    };
    // 原因：合法回调已消费后，即使浏览器中止响应也必须完成或撤销本机操作。
    response.once("finish", run);
    response.once("close", run);
  }

  async function start(): Promise<LoginLink> {
    if (disposed) throw failure("request_rejected");
    if (attempt) return { ...attempt.link };
    if (starting) return starting;
    const started = ++generation;
    const flight = (async () => {
      const owner = await options.begin();
      if (disposed || started !== generation) throw failure("session_changed");
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      const server = createServer((request, response) => {
        const current = attempt;
        if (!current || current.server !== server || current.consumed || started !== generation) {
          reply(response, 410, "本次登录已结束。请返回 MiloCode 重新发起登录。");
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          reply(response, 405, "请使用浏览器完成登录。");
          return;
        }
        const target = new URL(current.redirectUri);
        if (request.headers.host !== target.host || request.headers.origin) {
          reply(response, 400, "登录回调无效。请返回 MiloCode 重新发起登录。");
          return;
        }
        let url: URL;
        // 原因：URL会规范化点段和绝对request target；回调只接受精确原始路径。
        if (request.url?.split("?", 1)[0] !== CALLBACK_PATH) {
          reply(response, 404, "页面不存在。");
          return;
        }
        try {
          url = new URL(request.url ?? "", target.origin);
        } catch {
          reply(response, 400, "登录回调无效。");
          return;
        }
        if (url.origin !== target.origin || url.pathname !== CALLBACK_PATH) {
          reply(response, 404, "页面不存在。");
          return;
        }
        const values = url.searchParams;
        const received = values.get("state") ?? "";
        const expected = Buffer.from(current.state);
        const actual = Buffer.from(received);
        const keys = [...values.keys()];
        if (
          keys.some(
            (key) =>
              !["code", "state", "error", "error_description"].includes(key) ||
              values.getAll(key).length !== 1,
          ) ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          reply(response, 400, "登录校验失败。请返回 MiloCode 重新发起登录。");
          return;
        }
        if (values.has("error")) {
          if (values.has("code")) {
            reply(response, 400, "登录回调无效。");
            return;
          }
          current.consumed = true;
          clearTimeout(current.timer);
          afterReply(response, () => cancel("browser_login_cancelled"));
          reply(response, 200, "你可以关闭此页面。如需继续，请返回 MiloCode 重新发起登录。", "cancelled");
          return;
        }
        const code = values.get("code") ?? "";
        if (!code || code.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(code)) {
          reply(response, 400, "登录授权码无效，请重试。");
          return;
        }
        current.consumed = true;
        clearTimeout(current.timer);
        // 原因：先消费本地回调，防止浏览器重试触发第二次一次性换证；网络未知结果不重放。
        afterReply(response, () => {
          void options
            .complete(current.owner, {
              code,
              code_verifier: current.verifier,
              redirect_uri: current.redirectUri,
            })
            .catch((error: unknown) => {
              if (attempt === current) options.waiting(null, safeFailure(error).code);
            })
            .finally(() => {
              if (attempt === current) {
                attempt = null;
                options.waiting(null);
              }
              close(current);
            });
        });
        reply(response, 200, "请返回 MiloCode，客户端正在完成登录。此页可以关闭，最终登录状态以客户端为准。", "received");
      });
      server.requestTimeout = 5_000;
      server.headersTimeout = 5_000;
      server.maxHeadersCount = 32;
      server.maxConnections = 8;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      // 监听完成前的取消/退出不能留下无 owner 的端口。
      if (disposed || started !== generation) {
        server.close();
        throw failure("session_changed");
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw failure("request_rejected");
      }
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const url = new URL("/desktop/authorize", options.origin);
      url.search = new URLSearchParams({
        client_id: "zcode-desktop",
        response_type: "code",
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
      }).toString();
      const link = { authorizationUrl: url.toString(), expiresAt: Date.now() + LOGIN_WINDOW_MS };
      const timer = setTimeout(() => {
        if (attempt?.server === server) cancel("browser_login_expired");
      }, LOGIN_WINDOW_MS);
      timer.unref();
      attempt = { server, owner, verifier, state, redirectUri, link, timer, consumed: false };
      server.on("error", () => {
        if (attempt?.server === server) cancel("network");
      });
      options.waiting(link.expiresAt);
      return { ...link };
    })();
    starting = flight;
    try {
      return await flight;
    } catch (error) {
      if (started === generation) options.waiting(null, safeFailure(error).code);
      throw safeFailure(error);
    } finally {
      if (starting === flight) starting = null;
    }
  }

  return {
    start,
    cancel,
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}

/** 换证结果未知不重放；已签发但被取消或无法提交的refresh尽量服务端撤销。 */
export async function exchangeBrowserAuthorization(options: {
  body: { code: string; code_verifier: string; redirect_uri: string };
  request: (path: string, input: { body: unknown }) => Promise<unknown>;
  assertCurrent: () => void;
  commit: (data: unknown) => Promise<void>;
}) {
  const data = await options.request("/desktop/auth/token", { body: options.body });
  try {
    options.assertCurrent();
    await options.commit(data);
    options.assertCurrent();
  } catch (error) {
    const raw =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    const refresh = raw.refresh_token;
    if (typeof refresh === "string" && refresh.length > 0 && refresh.length < 16384)
      void options.request("/auth/logout", { body: { refresh_token: refresh } }).catch(() => {});
    throw error;
  }
}
