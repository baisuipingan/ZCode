/**
 * Standalone local runtime acceptance; no Electron, live accounts, or payments.
 * pnpm exec tsx --test packages/desktop/test/e2e/brand-account/manual-review/pending/brand-account-runtime.test.ts
 * Kept pending: does not imply Windows/macOS native-cipher or UI acceptance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrandAccountSnapshot } from "@zcode/services";

const serviceModule = new URL(
  "../../../../../../services/src/brand-account/index.ts",
  import.meta.url,
).href;
const { createBrandAccountService } = (await import(
  serviceModule
)) as typeof import("@zcode/services/node");

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function requestGate() {
  return { started: latch(), finish: latch() };
}

function testCipher(key: Buffer) {
  return {
    encrypt: async (value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },
    decrypt: async (value: string) => {
      const raw = Buffer.from(value, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "brand-account-runtime-"));
  const filePath = join(directory, "session.json");
  const key = randomBytes(32);
  const cipher = testCipher(key);
  const issued = new Map<string, number>();
  const refreshTokens = new Map<string, number>();
  let sequence = 0;
  const state = {
    requests: [] as {
      path: string;
      method: string;
      userAgent: string;
      amount?: number;
    }[],
    refreshes: 0,
    refreshRejectStatus: 0,
    meReads: 0,
    balance: 20,
    enabled: true,
    meFailure: false,
    twoFactor: false,
    loginSecond: latch(),
    loginGate: null as ReturnType<typeof requestGate> | null,
    meGate: null as ReturnType<typeof requestGate> | null,
    refreshGate: null as ReturnType<typeof requestGate> | null,
    createType: "order_created",
    extraCreate: {} as Record<string, unknown>,
    orderStatus: "PENDING",
  };
  function tokens(userId: number) {
    sequence += 1;
    const access = `E2E_PRIVATE_ACCESS_${sequence}`;
    const refresh = `E2E_PRIVATE_REFRESH_${sequence}`;
    issued.set(access, userId);
    refreshTokens.set(refresh, userId);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      token_type: "Bearer",
    };
  }
  const user = (id = 1) => ({
    id,
    email: `e2e-${id}@example.test`,
    username: `E2E_${id}`,
    balance: id === 1 ? state.balance : 77,
    frozen_balance: 3,
    balance_credits: 9007199254740993n.toString(),
  });
  const paymentOrder = () => ({
    id: 1,
    out_trade_no: "E2E_ORDER_1",
    status: state.orderStatus,
    order_type: "balance",
    payment_type: "alipay",
    amount: 14,
    bonus_amount: 2,
    pay_amount: 101,
    currency: "CNY",
    created_at: "2026-11-11T01:00:00Z",
    expires_at: "2026-11-11T02:00:00Z",
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = new URL(request.url!, "http://localhost").pathname;
    state.requests.push({
      path,
      method: request.method!,
      userAgent: String(request.headers["user-agent"]),
      amount: body.amount,
    });
    const ok = (data: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 0, data }));
    };
    const fail = (status: number) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          code: status,
          message: "E2E_PRIVATE_SERVER_MESSAGE",
          reason: "E2E_REQUEST_REJECTED",
        }),
      );
    };
    try {
      if (path.endsWith("/settings/public"))
        return ok({
          site_name: "E2E MiloRouter",
          registration_enabled: true,
          password_reset_enabled: true,
          turnstile_enabled: false,
          tencent_captcha_enabled: false,
          aliyun_captcha_enabled: false,
          payment_enabled: state.enabled,
          payment_balance_disabled: false,
          billing_currency_enabled: true,
          billing_engine: "credits",
          billing_display_currency: "USD",
          billing_usd_to_cny: 6.75,
          billing_settings_version: 9,
        });
      if (path.endsWith("/auth/login")) {
        const gate = state.loginGate;
        state.loginGate = null;
        gate?.started.release();
        if (gate) await gate.finish.promise;
        const id = body.email === "second@example.test" ? 2 : 1;
        if (id === 2) state.loginSecond.release();
        if (state.twoFactor)
          return ok({
            requires_2fa: true,
            temp_token: "E2E_PRIVATE_2FA",
            user_email_masked: "e***@example.test",
          });
        return ok({ ...tokens(id), user: user(id) });
      }
      if (path.endsWith("/auth/login/2fa")) {
        if (body.temp_token !== "E2E_PRIVATE_2FA" || body.totp_code !== "123456") return fail(401);
        return ok({ ...tokens(1), user: user() });
      }
      if (path.endsWith("/auth/refresh")) {
        state.refreshes += 1;
        if (state.refreshRejectStatus) return fail(state.refreshRejectStatus);
        const id = refreshTokens.get(body.refresh_token);
        refreshTokens.delete(body.refresh_token);
        if (!id) return fail(401);
        const gate = state.refreshGate;
        state.refreshGate = null;
        gate?.started.release();
        if (gate) await gate.finish.promise;
        return ok(tokens(id));
      }
      if (path.endsWith("/auth/logout")) {
        refreshTokens.delete(body.refresh_token);
        return ok({ message: "success" });
      }
      const id = issued.get(String(request.headers.authorization).replace(/^Bearer /, ""));
      if (!id) return fail(401);
      if (path.endsWith("/auth/me")) {
        state.meReads += 1;
        const data = user(id);
        const gate = state.meGate;
        state.meGate = null;
        gate?.started.release();
        if (gate) await gate.finish.promise;
        return state.meFailure ? fail(503) : ok(data);
      }
      if (path.endsWith("/payment/config"))
        return ok({
          enabled: state.enabled,
          balance_disabled: false,
          min_amount: 1,
          max_amount: 500,
          order_timeout_minutes: 30,
        });
      if (path.endsWith("/payment/checkout-info"))
        return ok({
          methods: {
            alipay: {
              payment_type: "alipay",
              display_name: "E2E Alipay",
              currency: "CNY",
              fee_rate: 1,
              daily_limit: 1000,
              single_min: 1,
              single_max: 500,
            },
          },
        });
      if (path.endsWith("/payment/orders/my"))
        return ok({
          items: [paymentOrder()],
          total: 1,
          page: 1,
          page_size: 20,
        });
      if (path.endsWith("/payment/orders/verify")) {
        state.orderStatus = "COMPLETED";
        state.balance = 50;
        return ok(paymentOrder());
      }
      if (path.endsWith("/payment/orders/1/cancel")) {
        state.orderStatus = "CANCELLED";
        return ok({ message: "cancelled" });
      }
      if (path.endsWith("/payment/orders/1")) return ok(paymentOrder());
      if (path.endsWith("/payment/orders")) {
        if (state.createType === "oauth_required")
          return ok({
            result_type: state.createType,
            oauth: {
              authorize_url: "https://example.test/oauth?token=E2E_PRIVATE_OAUTH",
            },
          });
        return ok({
          ...paymentOrder(),
          id: undefined,
          order_id: 1,
          result_type: state.createType,
          pay_url: "https://pay.example.test/order/E2E_ORDER_1",
          ...state.extraCreate,
        });
      }
      return fail(404);
    } catch {
      if (!response.headersSent) fail(500);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hosts = [] as ReturnType<typeof createBrandAccountService>[];
  const children: ChildProcess[] = [];
  const makeHost = (encrypt = cipher.encrypt) => {
    const host = createBrandAccountService({ baseUrl, filePath, ...cipher, encrypt });
    hosts.push(host);
    return host.service;
  };
  return {
    state,
    baseUrl,
    filePath,
    key,
    cipher,
    makeHost,
    expireAccess: () => issued.clear(),
    async childHost() {
      const script = `
        import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
        const { createBrandAccountService } = await import(${JSON.stringify(serviceModule)});
        const key = Buffer.from(process.env.E2E_CIPHER_KEY, 'base64');
        const host = createBrandAccountService({ baseUrl: process.env.E2E_ORIGIN, filePath: process.env.E2E_SESSION,
          encrypt: async (value) => { const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',key,iv); const b=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64'); },
          decrypt: async (value) => { const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'); }
        });
        host.service.onDidChange((snapshot)=>process.send({event:snapshot}));
        process.on('message', async ({id,method}) => { try { const result=await host.service[method]();process.send({id,result}); } catch(error){process.send({id,error:{code:error.code,message:error.message}});} });
        process.on('disconnect',()=>{host.dispose();process.exit(0);});
        process.send({ready:true});
      `;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            E2E_CIPHER_KEY: key.toString("base64"),
            E2E_ORIGIN: baseUrl,
            E2E_SESSION: filePath,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Child Host exited ${code}`)));
      });
      let nextId = 0;
      let latestSnapshot: BrandAccountSnapshot | null = null;
      child.on("message", (value: { event?: BrandAccountSnapshot }) => {
        if (value.event) latestSnapshot = value.event;
      });
      return {
        waitForStatus(status: BrandAccountSnapshot["status"], userId?: number): Promise<void> {
          const matches = (value: BrandAccountSnapshot | null | undefined) =>
            value?.status === status &&
            (userId === undefined ||
              (value.user?.id === userId && value.wallet.status === "fresh"));
          if (matches(latestSnapshot)) return Promise.resolve();
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              child.off("message", listener);
              reject(new Error(`Child Host did not observe ${status}`));
            }, 5_000);
            const listener = (value: { event?: BrandAccountSnapshot }) => {
              if (!matches(value.event)) return;
              clearTimeout(timeout);
              child.off("message", listener);
              resolve();
            };
            child.on("message", listener);
          });
        },
        call(
          method: "initialize" | "refreshBalance" | "getSnapshot" | "logout",
        ): Promise<BrandAccountSnapshot> {
          const id = ++nextId;
          return new Promise((resolve, reject) => {
            const listener = (value: {
              id?: number;
              result?: BrandAccountSnapshot;
              error?: { code: string; message: string };
            }) => {
              if (value.id !== id) return;
              child.off("message", listener);
              if (value.error)
                reject(
                  Object.assign(new Error(value.error.message), {
                    code: value.error.code,
                  }),
                );
              else resolve(value.result!);
            };
            child.on("message", listener);
            child.send({ id, method });
          });
        },
      };
    },
    async close() {
      state.meGate?.finish.release();
      state.refreshGate?.finish.release();
      hosts.forEach((host) => host.dispose());
      for (const child of children) {
        child.kill();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const credentials = {
  email: "first@example.test",
  password: "E2E_PRIVATE_PASSWORD",
};

test("AW02/04/05/06: real HTTP authoritative balance, same-Host singleflight, stale state and encrypted secrets", async () => {
  const f = await fixture();
  try {
    const service = f.makeHost();
    await service.initialize();
    const loggedIn = await service.login(credentials);
    assert.equal(loggedIn.wallet.availableUsd, 20);
    assert.equal(loggedIn.wallet.frozenUsd, 3);
    assert.equal(loggedIn.settings?.displayCurrency, "USD");
    const gate = requestGate();
    f.state.meGate = gate;
    const before = f.state.meReads;
    const first = service.refreshBalance();
    await gate.started.promise;
    const second = service.refreshBalance();
    gate.finish.release();
    const results = await Promise.all([first, second]);
    assert.equal(f.state.meReads - before, 1);
    assert.equal(results[0].wallet.fetchedAt, results[1].wallet.fetchedAt);
    f.state.meFailure = true;
    await assert.rejects(service.refreshBalance(), {
      code: "request_rejected",
    });
    const stale = await service.getSnapshot();
    assert.equal(stale.wallet.status, "stale");
    assert.equal(stale.wallet.availableUsd, 20);
    assert.equal(stale.wallet.fetchedAt, results[0].wallet.fetchedAt);
    const persisted = await readFile(f.filePath, "utf8");
    assert.doesNotMatch(persisted, /E2E_PRIVATE_|first@example/);
    assert.doesNotMatch(
      JSON.stringify(stale),
      /E2E_PRIVATE_|access_token|refresh_token|balance_credits/,
    );
    assert.equal(new Set(f.state.requests.map((request) => request.userAgent)).size, 1);
  } finally {
    await f.close();
  }
});

test("AW07/09: two child Hosts consume one rotating refresh and logout fences an in-flight refresh", async () => {
  const f = await fixture();
  try {
    const owner = f.makeHost();
    await owner.login(credentials);
    const [one, two] = await Promise.all([f.childHost(), f.childHost()]);
    await Promise.all([one.call("initialize"), two.call("initialize")]);
    f.expireAccess();
    await Promise.all([one.call("refreshBalance"), two.call("refreshBalance")]);
    assert.equal(f.state.refreshes, 1);
    f.expireAccess();
    const gate = requestGate();
    f.state.refreshGate = gate;
    const updating = one.call("refreshBalance").catch((error) => error);
    await gate.started.promise;
    const loggingOut = owner.logout();
    gate.finish.release();
    await Promise.all([updating, loggingOut]);
    await two.waitForStatus("signedOut");
    const restored = await two.call("getSnapshot");
    assert.equal(restored.status, "signedOut");
    assert.equal(restored.user, null);
    const outer = JSON.parse(await readFile(f.filePath, "utf8"));
    const privateSession = JSON.parse(await f.cipher.decrypt(outer.ciphertext));
    assert.equal(privateSession.credentials, null);
    assert.equal(f.state.refreshes, 2);
  } finally {
    await f.close();
  }
});

test("AW09: logout intent prevents a pending refresh HTTP response from entering encryption", async () => {
  const f = await fixture();
  const gate = requestGate();
  const encryptedAccess: Array<string | null> = [];
  try {
    const service = f.makeHost(async (value) => {
      encryptedAccess.push(JSON.parse(value).credentials?.accessToken ?? null);
      return f.cipher.encrypt(value);
    });
    await service.login(credentials);
    f.expireAccess();
    f.state.refreshGate = gate;
    const refreshing = service.refreshBalance();
    const refreshRejected = assert.rejects(refreshing, { code: "session_changed" });
    await gate.started.promise;
    const loggingOut = service.logout();
    gate.finish.release();
    await refreshRejected;
    await loggingOut;
    assert.equal(encryptedAccess.includes("E2E_PRIVATE_ACCESS_2"), false);
    const outer = JSON.parse(await readFile(f.filePath, "utf8"));
    const session = JSON.parse(await f.cipher.decrypt(outer.ciphertext));
    assert.equal(session.credentials, null);
    assert.equal((await service.getSnapshot()).status, "signedOut");
  } finally {
    gate.finish.release();
    await f.close();
  }
});

test("AW09: a delayed old-account me cannot overwrite a newly logged-in account", async () => {
  const f = await fixture();
  try {
    const service = f.makeHost();
    await service.login(credentials);
    const gate = requestGate();
    f.state.meGate = gate;
    const oldRead = service.refreshBalance().catch((error) => error);
    await gate.started.promise;
    await service.logout();
    const nextLogin = service.login({
      email: "second@example.test",
      password: "E2E_PRIVATE_PASSWORD_B",
    });
    await f.state.loginSecond.promise;
    gate.finish.release();
    await oldRead;
    const next = await nextLogin;
    assert.equal(next.user?.id, 2);
    assert.equal(next.wallet.availableUsd, 77);
    assert.equal((await service.getSnapshot()).user?.id, 2);
  } finally {
    await f.close();
  }
});

test("AW09: sibling Host observes login tombstone then credentials at the same epoch", async () => {
  const f = await fixture();
  const gate = requestGate();
  try {
    const owner = f.makeHost();
    await owner.login(credentials);
    const sibling = await f.childHost();
    await sibling.call("initialize");
    f.state.loginGate = gate;
    const nextLogin = owner.login({
      email: "second@example.test",
      password: "E2E_PRIVATE_PASSWORD_B",
    });
    await gate.started.promise;
    await sibling.waitForStatus("signedOut");
    gate.finish.release();
    await nextLogin;
    await sibling.waitForStatus("authenticated", 2);
    const restored = await sibling.call("getSnapshot");
    assert.equal(restored.user?.id, 2);
    assert.equal(restored.wallet.availableUsd, 77);
  } finally {
    gate.finish.release();
    await f.close();
  }
});

test("AW13/14/17: COMPLETED queues a new me after a pre-fulfillment read and never credits locally", async () => {
  const f = await fixture();
  try {
    const service = f.makeHost();
    await service.login(credentials);
    const gate = requestGate();
    f.state.meGate = gate;
    const before = f.state.meReads;
    const oldRead = service.refreshBalance();
    await gate.started.promise;
    const completionInvalidated = latch();
    const listener = service.onDidChange(() => {
      if (f.state.orderStatus === "COMPLETED") completionInvalidated.release();
    });
    const verifying = service.verifyOrder("E2E_ORDER_1");
    await completionInvalidated.promise;
    listener.dispose();
    assert.equal((await service.getSnapshot()).wallet.availableUsd, 20);
    gate.finish.release();
    const [, paid] = await Promise.all([oldRead, verifying]);
    assert.equal(paid.status, "COMPLETED");
    const result = await service.getSnapshot();
    assert.equal(result.wallet.availableUsd, 50);
    assert.equal(f.state.meReads - before, 2);
  } finally {
    await f.close();
  }
});

test("AW11/12/16: disabled checkout, channel currency, and payment unions follow real backend DTOs", async () => {
  const f = await fixture();
  try {
    const service = f.makeHost();
    await service.login(credentials);
    f.state.enabled = false;
    assert.equal((await service.getCheckout()).enabled, false);
    await assert.rejects(service.createOrder({ amount: 100, paymentType: "alipay" }), {
      code: "payment_unavailable",
    });
    assert.equal(
      f.state.requests.filter(
        (request) => request.path.endsWith("/payment/orders") && request.method === "POST",
      ).length,
      0,
    );
    assert.equal((await service.listOrders()).items.length, 1);
    f.state.enabled = true;
    const payment = await service.createOrder({
      amount: 100,
      paymentType: "alipay",
    });
    assert.equal(payment.kind, "payment");
    if (payment.kind !== "payment") throw new Error("Expected payment");
    assert.equal(payment.order.creditedUsd, 14);
    assert.equal(payment.order.bonusUsd, 2);
    assert.equal(payment.order.payAmount, 101);
    assert.equal(payment.order.paymentCurrency, "CNY");
    assert.equal((await service.getSnapshot()).wallet.availableUsd, 20);
    f.state.extraCreate = { currency: undefined };
    const omittedCurrency = await service.createOrder({
      amount: 100,
      paymentType: "alipay",
    });
    assert.equal(omittedCurrency.kind, "payment");
    assert.equal(omittedCurrency.order?.paymentCurrency, "CNY");
    f.state.extraCreate = {};
    f.state.createType = "oauth_required";
    assert.deepEqual(await service.createOrder({ amount: 100, paymentType: "alipay" }), {
      kind: "unsupported",
      reason: "oauth",
      order: null,
    });
    f.state.createType = "order_created";
    f.state.extraCreate = { client_secret: "E2E_PRIVATE_PROVIDER_SECRET" };
    const unsupported = await service.createOrder({
      amount: 100,
      paymentType: "alipay",
    });
    assert.equal(unsupported.kind, "unsupported");
    assert.doesNotMatch(JSON.stringify(unsupported), /E2E_PRIVATE_PROVIDER_SECRET/);
    f.state.extraCreate = { pay_url: "javascript:alert(1)" };
    assert.equal(
      (await service.createOrder({ amount: 100, paymentType: "alipay" })).kind,
      "unsupported",
    );
  } finally {
    await f.close();
  }
});

test("AW01/08: 2FA stays Host-private and a rejecting OS cipher never falls back to plaintext", async () => {
  const f = await fixture();
  try {
    f.state.twoFactor = true;
    const service = f.makeHost();
    const challenge = await service.login(credentials);
    assert.equal(challenge.status, "twoFactor");
    assert.doesNotMatch(JSON.stringify(challenge), /E2E_PRIVATE_2FA/);
    assert.equal((await service.completeTwoFactor("123456")).status, "authenticated");
    const blocked = createBrandAccountService({
      baseUrl: f.baseUrl,
      filePath: `${f.filePath}.blocked`,
      encrypt: async () => {
        throw new Error("E2E_PRIVATE_OS_ERROR");
      },
      decrypt: f.cipher.decrypt,
    });
    try {
      await assert.rejects(blocked.service.login(credentials), {
        code: "storage_unavailable",
      });
    } finally {
      blocked.dispose();
    }
  } finally {
    await f.close();
  }
});

test(
  "AW08: a timed-out refresh preserves an uncertain session and never replays the consumed token",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const gate = requestGate();
    try {
      const service = f.makeHost();
      await service.login(credentials);
      f.expireAccess();
      f.state.refreshGate = gate;
      const reading = service.refreshBalance();
      await gate.started.promise;
      await assert.rejects(reading, { code: "reauthentication_required" });
      assert.equal(f.state.refreshes, 1);
      await assert.rejects(service.refreshBalance(), {
        code: "reauthentication_required",
      });
      assert.equal(f.state.refreshes, 1);
      const snapshot = await service.getSnapshot();
      assert.equal(snapshot.status, "authenticated");
      assert.equal(snapshot.wallet.status, "stale");
      assert.equal(snapshot.wallet.availableUsd, 20);
      const outer = JSON.parse(await readFile(f.filePath, "utf8"));
      const session = JSON.parse(await f.cipher.decrypt(outer.ciphertext));
      assert.equal(session.refreshUncertain, true);
      assert.ok(session.credentials.refreshToken);
    } finally {
      gate.finish.release();
      await f.close();
    }
  },
);

test("AW08: refresh rate limiting does not consume the pair and permits a later manual retry", async () => {
  const f = await fixture();
  try {
    const service = f.makeHost();
    await service.login(credentials);
    f.expireAccess();
    f.state.refreshRejectStatus = 429;
    await assert.rejects(service.refreshBalance(), { code: "rate_limited" });
    const outer = JSON.parse(await readFile(f.filePath, "utf8"));
    const session = JSON.parse(await f.cipher.decrypt(outer.ciphertext));
    assert.equal(session.refreshUncertain, false);
    f.state.refreshRejectStatus = 0;
    assert.equal((await service.refreshBalance()).wallet.status, "fresh");
    assert.equal(f.state.refreshes, 2);
  } finally {
    await f.close();
  }
});
