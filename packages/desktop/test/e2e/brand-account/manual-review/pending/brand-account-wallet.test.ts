import {
  createBrowserAuthorizationFixture,
  installBrowserAuthorizationFixture,
} from "./browser-login-fixture.js";
// 独立真实 Electron + HTTP 控制面验收，不加入 WDIO/provider replay preset。
// 前置：desktop tsup 产物与 localhost:5174 renderer。禁止连接真实支付商。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "../../../../../../..");
const require = createRequire(import.meta.url);

test(
  "AW native: login, authoritative wallet, rotated restore and recharge recovery",
  { timeout: 240_000 },
  async () => {
    const artifacts = resolve(
      root,
      "packages/desktop/.e2e-artifacts",
      `brand-account-${Date.now()}`,
    );
    const data = join(artifacts, "data");
    await mkdir(data, { recursive: true });
    const counts: Record<string, number> = {};
    const trace: Array<{ method: string; path: string; status: number }> = [];
    let balance = 12.34;
    let meFails = false;
    let expireAccess = false;
    let refreshGeneration = 1;
    let paymentEnabled = true;
    let displayCurrency = "USD";
    let orderStatus = "PENDING";
    let created = false;
    const user = () => ({
      id: 101,
      email: "e2e-wallet@example.invalid",
      username: "E2E Wallet",
      balance,
      frozen_balance: 2.5,
    });
    const order = () => ({
      id: 401,
      user_id: 101,
      out_trade_no: "E2E_AW_ORDER_401",
      status: orderStatus,
      amount: 9.5,
      bonus_amount: 0.5,
      pay_amount: 68.25,
      currency: "CNY",
      payment_type: "alipay",
      order_type: "balance",
      created_at: "2026-11-11T00:00:00Z",
      expires_at: "2030-11-11T01:00:00Z",
      paid_at: null,
      completed_at: orderStatus === "COMPLETED" ? "2026-11-11T00:02:00Z" : null,
    });
    const browserAuthorization = createBrowserAuthorizationFixture(() => 101);
    const server = createServer(async (request, response) => {
      if (browserAuthorization.authorize(request, response)) return;
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const key = `${request.method} ${path}`;
      counts[key] = (counts[key] ?? 0) + 1;
      const reply = (value: unknown, status = 200) => {
        trace.push({ method: request.method ?? "", path, status });
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            code: status === 200 ? 0 : status,
            message: status === 200 ? "ok" : "fixture error",
            data: value,
          }),
        );
      };
      let body: Record<string, unknown> = {};
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
      if (path.endsWith("/settings/public"))
        return reply({
          site_name: "E2E MiloRouter",
          registration_enabled: true,
          password_reset_enabled: true,
          turnstile_enabled: false,
          tencent_captcha_enabled: false,
          aliyun_captcha_enabled: false,
          payment_enabled: paymentEnabled,
          payment_balance_disabled: false,
          billing_currency_enabled: true,
          billing_engine: "credits",
          billing_display_currency: displayCurrency,
          billing_usd_to_cny: 6.75,
          billing_settings_version: 9,
        });
      if (path.endsWith("/desktop/auth/token")) {
        assert.equal(browserAuthorization.exchange(body), 101);
        return reply({
          access_token: "E2E_AW_ACCESS_1",
          refresh_token: "E2E_AW_REFRESH_1",
          expires_in: 3600,
          user: user(),
        });
      }
      if (path.endsWith("/auth/refresh")) {
        assert.equal(body.refresh_token, `E2E_AW_REFRESH_${refreshGeneration}`);
        refreshGeneration += 1;
        expireAccess = false;
        return reply({
          access_token: `E2E_AW_ACCESS_${refreshGeneration}`,
          refresh_token: `E2E_AW_REFRESH_${refreshGeneration}`,
          expires_in: 3600,
        });
      }
      if (path.endsWith("/auth/logout")) return reply({});
      if (!request.headers.authorization) return reply({}, 401);
      if (path.endsWith("/auth/me")) {
        if (expireAccess) return reply({}, 401);
        if (meFails) return reply({}, 503);
        return reply(user());
      }
      if (path.endsWith("/payment/config"))
        return reply({
          enabled: paymentEnabled,
          balance_disabled: false,
          min_amount: 10,
          max_amount: 1000,
          order_timeout_minutes: 30,
          help_text: "E2E payment fixture — no real charge",
        });
      if (path.endsWith("/payment/checkout-info"))
        return reply({
          methods: {
            alipay: {
              payment_type: "alipay",
              display_name: "E2E Alipay",
              currency: "CNY",
              fee_rate: 0.01,
              single_min: 20,
              single_max: 500,
              daily_limit: 0,
            },
          },
        });
      if (path.endsWith("/orders/my"))
        return reply({
          items: created ? [order()] : [],
          total: created ? 1 : 0,
          page: 1,
          page_size: 20,
        });
      if (path.endsWith("/payment/orders") && request.method === "POST") {
        assert.equal(body.amount, 60);
        assert.equal(body.payment_type, "alipay");
        assert.equal(body.order_type, "balance");
        created = true;
        return reply({
          ...order(),
          currency: undefined,
          order_id: 401,
          result_type: "order_created",
          qr_code: "https://pay.example.invalid/E2E_AW_ORDER_401",
          pay_url: "https://pay.example.invalid/E2E_AW_ORDER_401",
        });
      }
      if (path.endsWith("/orders/verify") || path.endsWith("/orders/401")) return reply(order());
      return reply({}, 404);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    const seenRequests = new Set<string>();
    const start = async () => {
      app = await electron.launch({
        executablePath: process.env.ZCODE_ACCOUNT_E2E_EXECUTABLE ?? require("electron"),
        args: [resolve(root, "packages/desktop")],
        env: {
          ...process.env,
          ZCODE_ENV: "production",
          ELECTRON_RENDERER_URL:
            process.env.ZCODE_ACCOUNT_E2E_RENDERER_URL ?? "http://localhost:5174",
          MILOROUTER_ACCOUNT_BASE_URL: origin,
          ZCODE_DESKTOP_APPLICATION_NAME: `ZCode Account E2E ${address.port}`,
          ZCODE_DESKTOP_HOME_DIR: data,
          ZCODE_DESKTOP_USER_DATA_DIR: join(artifacts, "electron"),
          ZCODE_DESKTOP_SESSION_DATA_DIR: join(artifacts, "session"),
          ZCODE_DATA_BASE_DIR: data,
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
          NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repository",
        },
        timeout: 45_000,
      });
      app.process().stderr?.on("data", () => {});
      await installBrowserAuthorizationFixture(app, origin);
      page = await app.firstWindow({ timeout: 40_000 });
      page.setDefaultTimeout(60_000);
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== "http://localhost:5174") seenRequests.add(url.origin + url.pathname);
      });
      return page;
    };
    const waitText = async (current: Page, id: string, value: string) => {
      await current.waitForFunction(
        ({ id, value }) =>
          [...document.querySelectorAll(`[data-testid="${id}"]`)].some((node) =>
            node.textContent?.includes(value),
          ),
        { id, value },
      );
    };
    const checkBalance = async (current: Page, value: string) =>
      waitText(current, "brand-account-balance", value);
    const passed: string[] = [];
    try {
      page = await start();
      await page.getByTestId("brand-account-submit").click();
      for (let step = 0; step < 3; step += 1) {
        await page
          .getByTestId("onboarding-page")
          .getByRole("button", { name: /^(跳过|Skip)$/u })
          .click();
      }
      await checkBalance(page, "12.34");
      assert.equal(counts["POST /api/v1/desktop/auth/token"], 1);
      assert((counts["GET /api/v1/auth/me"] ?? 0) > 0);
      passed.push("AW01: native login and server balance (frozen not subtracted)");
      await page.screenshot({ path: join(artifacts, "01-account.png") });
      const privatePath = join(artifacts, "electron/brand-account/session.json");
      const encrypted = await readFile(privatePath, "utf8");
      assert(
        !encrypted.includes("E2E_AW_ACCESS") &&
          !encrypted.includes("E2E_AW_REFRESH") &&
          !encrypted.includes("E2E_AW_PASSWORD"),
      );
      const storage = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          url: location.href,
        }),
      );
      assert(
        !storage.includes("E2E_AW_ACCESS") &&
          !storage.includes("E2E_AW_REFRESH") &&
          !storage.includes("E2E_AW_PASSWORD"),
      );
      passed.push("AW10 partial: OS encrypted file and no browser token storage");
      balance = 7.89;
      await page.getByTestId("brand-account-refresh").first().click();
      await checkBalance(page, "7.89");
      passed.push("AW04: manual refresh reads server amount");
      meFails = true;
      await page.getByTestId("brand-account-refresh").first().click();
      await page.waitForFunction(
        () =>
          document.body.textContent?.includes("同步失败") ||
          document.body.textContent?.includes("Sync failed"),
      );
      await checkBalance(page, "7.89");
      passed.push("AW05 partial: failed read preserves previous balance");
      meFails = false;
      expireAccess = true;
      balance = 6.78;
      await page.getByTestId("brand-account-refresh").first().click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector('[data-testid="brand-account-refresh"]')
            ?.hasAttribute("disabled"),
      );
      await checkBalance(page, "6.78");
      assert.equal(counts["POST /api/v1/auth/refresh"], 1);
      passed.push("AW07 partial: 401 rotates pair once and replays GET");
      await page.getByTestId("brand-account-recharge").first().click();
      await page.getByTestId("brand-recharge-amount").fill("60");
      await page.getByTestId("brand-recharge-submit").click();
      await page.getByTestId("brand-order-status").waitFor();
      assert.equal(counts["POST /api/v1/payment/orders"], 1);
      await page.getByTestId("brand-recharge-dialog").getByRole("img").waitFor();
      await checkBalance(page, "6.78");
      await page.screenshot({ path: join(artifacts, "02-pending-order.png") });
      passed.push("AW11/12/16 partial: server channel and amount, one POST, QR rendered");
      orderStatus = "PAID";
      await page.getByTestId("brand-recharge-verify").click();
      await waitText(page, "brand-order-status", "确认").catch(async () =>
        waitText(page!, "brand-order-status", "confirmed"),
      );
      await checkBalance(page, "6.78");
      orderStatus = "RECHARGING";
      await page.getByTestId("brand-recharge-verify").click();
      await waitText(page, "brand-order-status", "入账").catch(async () =>
        waitText(page!, "brand-order-status", "Processing"),
      );
      await checkBalance(page, "6.78");
      // fixture账本直接给出5.43；既不等于实付，也不等于客户端旧值+到账额。
      balance = 5.43;
      orderStatus = "COMPLETED";
      await page.getByTestId("brand-recharge-verify").click();
      await checkBalance(page, "5.43");
      assert(
        trace.findIndex((row) => row.path.endsWith("/orders/verify")) <
          trace.map((row) => row.path).lastIndexOf("/api/v1/auth/me"),
      );
      await page.screenshot({
        path: join(artifacts, "03-completed-order.png"),
      });
      passed.push("AW13: PENDING/PAID/RECHARGING do not credit; COMPLETED rereads me");
      await page.getByTestId("brand-recharge-close").click();
      await app!.close();
      app = undefined;
      balance = 4.56;
      displayCurrency = "CNY";
      page = await start();
      await checkBalance(page, "30.78");
      assert.equal(counts["POST /api/v1/desktop/auth/token"], 1);
      passed.push("AW02: native restart decrypts session and loads new balance");
      await page.getByTestId("brand-account-recharge").first().click();
      await page.getByTestId("brand-recharge-dialog").getByTestId("brand-order-401").click();
      await page.getByTestId("brand-order-status").waitFor();
      passed.push("AW15 partial: own order restored after restart; close did not cancel");
      await page.getByTestId("brand-recharge-close").click();
      paymentEnabled = false;
      await page.getByTestId("brand-account-recharge").first().click();
      await page.getByTestId("brand-recharge-unavailable").waitFor();
      assert.equal(counts["POST /api/v1/payment/orders"], 1);
      passed.push("AW11 partial: payment-disabled config prevents another order");
      await page.getByTestId("brand-recharge-close").click();
      await page.getByTestId("brand-account-open").first().click();
      const account = page.getByTestId("brand-account-section");
      await account.waitFor();
      assert((await account.textContent())?.includes("e2e-wallet@example.invalid"));
      assert((await account.textContent())?.includes("16.88"));
      await page.screenshot({ path: join(artifacts, "04-account-orders.png") });
      passed.push("AW02 partial: profile, frozen funds, wallet and own orders in settings");
      await page.getByTestId("brand-account-logout").click();
      await page
        .getByRole("button", { name: /退出登录|Sign out/u })
        .last()
        .click();
      await page.getByTestId("brand-account-submit").waitFor();
      passed.push("AW09 partial: explicit logout returns to native login");
      assert(
        ![...seenRequests].some((url) => /\/coding-plan|\/rewards|\/marketing/u.test(url)),
        "Brand mode must not request official account business APIs",
      );
    } finally {
      if (page && !page.isClosed())
        await page.screenshot({ path: join(artifacts, "last-state.png") }).catch(() => {});
      await writeFile(
        join(artifacts, "result.json"),
        JSON.stringify({ passed, counts, trace, rendererRequests: [...seenRequests] }, null, 2),
      );
      await app?.close().catch(() => {});
      await new Promise<void>((done) => server.close(() => done()));
      console.log(`Account E2E evidence: ${artifacts}`);
    }
  },
);
