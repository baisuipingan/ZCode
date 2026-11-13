/** Local HTTP + loopback acceptance. No live credentials, Electron, payments or model calls. */
import assert from "node:assert/strict";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { createServer, request as requestHttp } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const serviceModule = new URL(
  "../../../../../../services/src/brand-account/index.ts",
  import.meta.url,
).href;
const { createBrandAccountService } = (await import(
  serviceModule
)) as typeof import("@zcode/services/node");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "brand-browser-login-"));
  const key = randomBytes(32);
  let exchanges = 0;
  let revoked = 0;
  let exchangeWait: Promise<void> | null = null;
  let authorization: URL;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = new URL(request.url!, "http://localhost").pathname;
    let data: unknown;
    if (path === "/api/v1/settings/public")
      data = {
        site_name: "Fixture",
        turnstile_enabled: true,
        billing_display_currency: "USD",
        billing_usd_to_cny: 1,
      };
    else if (path === "/api/v1/desktop/auth/token") {
      exchanges += 1;
      if (exchangeWait) await exchangeWait;
      assert.equal(body.code, "fixture_one_use_code");
      assert.equal(body.redirect_uri, authorization.searchParams.get("redirect_uri"));
      assert.equal(
        createHash("sha256").update(body.code_verifier).digest("base64url"),
        authorization.searchParams.get("code_challenge"),
      );
      data = {
        access_token: "BROWSER_PRIVATE_ACCESS",
        refresh_token: "BROWSER_PRIVATE_REFRESH",
        expires_in: 3600,
        user: { id: 1, email: "fixture@example.test", username: "fixture" },
      };
    } else if (path === "/api/v1/auth/me")
      data = {
        id: 1,
        email: "fixture@example.test",
        username: "fixture",
        balance: 20,
        frozen_balance: 0,
      };
    else if (path === "/api/v1/auth/logout") {
      revoked += 1;
      data = {};
    } else {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server");
  const filePath = join(dir, "session.json");
  const factory = () =>
    createBrandAccountService({
      baseUrl: `http://127.0.0.1:${address.port}`,
      filePath,
      encrypt: async (value) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const result = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), result]).toString("base64");
      },
      decrypt: async (value) => {
        const raw = Buffer.from(value, "base64");
        const cipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        cipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString("utf8");
      },
    });
  const host = factory();
  await host.service.initialize();
  return {
    host,
    factory,
    filePath,
    exchanges: () => exchanges,
    revoked: () => revoked,
    holdExchange() {
      let release!: () => void;
      exchangeWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    async begin() {
      const result = await host.service.startBrowserLogin();
      authorization = new URL(result.authorizationUrl);
      assert.equal(authorization.pathname, "/desktop/authorize");
      assert.equal(authorization.searchParams.get("client_id"), "zcode-desktop");
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.ok(!result.authorizationUrl.includes("verifier"));
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "fixture_one_use_code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      return { result, callback };
    },
    async cleanup() {
      host.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitAuthenticated(host: ReturnType<typeof createBrandAccountService>) {
  for (let i = 0; i < 100; i += 1) {
    const snapshot = await host.service.getSnapshot();
    if (snapshot.user?.id === 1 && snapshot.wallet.status === "fresh") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("browser login did not finish");
}

async function rawCallback(callback: URL, path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const request = requestHttp(
      { hostname: callback.hostname, port: callback.port, path, headers },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function assertCallbackPage(response: Response, title: string, callback: URL) {
  const html = await response.text();
  assert.ok(html.includes(`<title>${title} · MiloCode</title>`));
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(!html.includes("ZCode"));
  assert.ok(!html.includes("登录成功"));
  for (const secret of [callback.searchParams.get("state"), callback.searchParams.get("code"), "BROWSER_PRIVATE"])
    if (secret) assert.ok(!html.includes(secret), "callback page must not reflect authorization secrets");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const csp = response.headers.get("content-security-policy") ?? "";
  const nonce = html.match(/<style nonce="([A-Za-z0-9+/=]+)">/)?.[1];
  assert.ok(nonce);
  assert.ok(csp.includes(`style-src 'nonce-${nonce}'`));
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(!html.includes("<script"));
  return html;
}

test("browser authorization works with website captcha and uses existing encrypted account/ledger", async () => {
  const f = await fixture();
  try {
    const { result, callback } = await f.begin();
    assert.equal((await f.host.service.getSnapshot()).browserLogin.status, "waiting");
    assert.deepEqual(await f.host.service.startBrowserLogin(), result);
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    const html = await assertCallbackPage(response, "授权已接收", callback);
    assert.ok(html.includes("最终登录状态以客户端为准"));
    const snapshot = await waitAuthenticated(f.host);
    assert.equal(snapshot.wallet.availableUsd, 20);
    assert.equal(snapshot.browserLogin.status, "idle");
    assert.equal(f.exchanges(), 1);
    assert.ok(!(await readFile(f.filePath, "utf8")).includes("BROWSER_PRIVATE"));
    assert.ok(!JSON.stringify(snapshot).includes("BROWSER_PRIVATE"));
    await assert.rejects(fetch(callback));
  } finally {
    await f.cleanup();
  }
});

test("invalid loopback requests do not consume the waiting authorization", async () => {
  const f = await fixture();
  try {
    const { callback } = await f.begin();
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "wrong");
    const rejected = await fetch(wrongState);
    assert.equal(rejected.status, 400);
    await assertCallbackPage(rejected, "无法完成授权", callback);
    const repeated = new URL(callback);
    repeated.searchParams.append("code", "other");
    assert.equal((await fetch(repeated)).status, 400);
    assert.equal((await fetch(callback, { method: "POST" })).status, 405);
    const wrongPath = new URL(callback);
    wrongPath.pathname = "/other";
    assert.equal((await fetch(wrongPath)).status, 404);
    const query = callback.search;
    assert.equal(await rawCallback(callback, `/other/../callback${query}`), 404);
    assert.equal(await rawCallback(callback, callback.toString()), 404);
    assert.equal(await rawCallback(callback, `/callback${query}`, { Host: "localhost" }), 400);
    assert.equal(
      await rawCallback(callback, `/callback${query}`, { Origin: "https://foreign.example" }),
      400,
    );
    assert.equal(f.exchanges(), 0);
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await assertCallbackPage(response, "授权已接收", callback);
    await waitAuthenticated(f.host);
    assert.equal(f.exchanges(), 1);
  } finally {
    await f.cleanup();
  }
});

test("a valid website denial ends the attempt without exchanging tokens", async () => {
  const f = await fixture();
  try {
    const { callback } = await f.begin();
    callback.searchParams.delete("code");
    callback.searchParams.set("error", "access_denied");
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await assertCallbackPage(response, "已取消登录", callback);
    const snapshot = await f.host.service.getSnapshot();
    assert.equal(snapshot.browserLogin.status, "idle");
    assert.equal(snapshot.error?.code, "browser_login_cancelled");
    assert.equal(f.exchanges(), 0);
    await assert.rejects(fetch(callback));
  } finally {
    await f.cleanup();
  }
});

test("cancelling an already completed browser login preserves the signed-in account", async () => {
  const f = await fixture();
  try {
    const { callback } = await f.begin();
    await fetch(callback);
    const before = await waitAuthenticated(f.host);
    await f.host.service.cancelBrowserLogin();
    const after = await f.host.service.getSnapshot();
    assert.equal(after.status, "authenticated");
    assert.equal(after.accountEpoch, before.accountEpoch);
    assert.equal(after.user?.id, before.user?.id);
    assert.equal(f.revoked(), 0);
  } finally {
    await f.cleanup();
  }
});

test("cancel and logout close waiting callbacks without exchanging tokens", async () => {
  const f = await fixture();
  try {
    const first = await f.begin();
    await f.host.service.cancelBrowserLogin();
    assert.equal((await f.host.service.getSnapshot()).browserLogin.status, "idle");
    await assert.rejects(fetch(first.callback));
    const second = await f.begin();
    await f.host.service.logout();
    await assert.rejects(fetch(second.callback));
    assert.equal(f.exchanges(), 0);
  } finally {
    await f.cleanup();
  }
});

test("a sibling Host authorization supersedes an earlier callback without exchanging it", async () => {
  const f = await fixture();
  const sibling = f.factory();
  try {
    const { callback } = await f.begin();
    await sibling.service.initialize();
    await sibling.service.startBrowserLogin();
    await fetch(callback);
    for (
      let i = 0;
      i < 50 && (await f.host.service.getSnapshot()).browserLogin.status !== "idle";
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.exchanges(), 0);
    assert.equal((await f.host.service.getSnapshot()).status, "signedOut");
  } finally {
    sibling.dispose();
    await f.cleanup();
  }
});

test("cancel during token exchange discards and revokes the late pair", async () => {
  const f = await fixture();
  const release = f.holdExchange();
  try {
    const { callback } = await f.begin();
    await fetch(callback);
    for (let i = 0; i < 100 && f.exchanges() === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.exchanges(), 1);
    const cancelled = f.host.service.cancelBrowserLogin();
    release();
    await cancelled;
    for (let i = 0; i < 100 && f.revoked() === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await f.host.service.getSnapshot()).status, "signedOut");
    assert.equal(f.revoked(), 1);
  } finally {
    release();
    await f.cleanup();
  }
});
