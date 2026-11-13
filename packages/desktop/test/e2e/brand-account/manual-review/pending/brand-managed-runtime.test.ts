// 真实Host账户/HTTP/私有resolver验收；不冒充原生CLI或生产后端验证。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { BrandAccountSnapshot } from "@zcode/services";
import { zcodeProviderRuntimeHeadersResponseSchema } from "@zcode/shared";
import {
  createManagedInferenceFixture,
  latch,
  MI_MODEL,
  MI_SECRETS,
} from "./managed-inference-fixture.js";
import { resolveManagedProviderPolicy } from "@zcode/provider";
import { managedModelConfigFingerprint } from "@zcode/shared/model-selection";

const serviceModule = new URL(
  "../../../../../../services/src/brand-account/index.ts",
  import.meta.url,
).href;
const { createBrandAccountService } = (await import(
  serviceModule
)) as typeof import("@zcode/services/node");

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "brand-managed-runtime-"));
  const gateway = await createManagedInferenceFixture(join(directory, "unused-output.txt"));
  const filePath = join(directory, "session.json");
  const key = randomBytes(32);
  const io: {
    beforeEncrypt?: (value: string) => Promise<void>;
    beforeDecrypt?: () => Promise<void>;
  } = {};
  const cipher = {
    encrypt: async (value: string) => {
      await io.beforeEncrypt?.(value);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, c.update(value, "utf8"), c.final(), c.getAuthTag()]).toString(
        "base64",
      );
    },
    decrypt: async (value: string) => {
      await io.beforeDecrypt?.();
      const raw = Buffer.from(value, "base64");
      const c = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      c.setAuthTag(raw.subarray(-16));
      return Buffer.concat([c.update(raw.subarray(12, -16)), c.final()]).toString("utf8");
    },
  };
  const hosts: ReturnType<typeof createBrandAccountService>[] = [];
  const host = () => {
    const result = createBrandAccountService({
      baseUrl: gateway.baseUrl,
      filePath,
      ...cipher,
      managedInference: { clientVersion: "e2e-mi", platform: "darwin" },
    });
    hosts.push(result);
    return result;
  };
  return {
    gateway,
    host,
    filePath,
    cipher,
    io,
    async close() {
      hosts.forEach((h) => h.dispose());
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const login = (account: number) => ({
  email: `e2e-mi-${account}@example.invalid`,
  password: "E2E_MI_PASSWORD",
});
async function waitInference(
  host: ReturnType<typeof createBrandAccountService>,
  status: BrandAccountSnapshot["inference"]["status"],
) {
  if ((await host.service.getSnapshot()).inference.status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      listener.dispose();
      reject(new Error(`Inference did not become ${status}`));
    }, 5000);
    const listener = host.service.onDidChange((snapshot) => {
      if (snapshot.inference.status !== status) return;
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    });
    void host.service.getSnapshot().then((snapshot) => {
      if (snapshot.inference.status !== status) return;
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    });
  });
}
const configured = async (host: ReturnType<typeof createBrandAccountService>) => {
  await host.service.initialize();
  await waitInference(host, "configured");
  assert.equal((await host.service.getSnapshot()).inference.status, "configured");
  const policy = host.inference.getPolicy();
  assert.equal(policy.state, "ready");
  if (policy.state !== "ready") throw new Error("Expected ready managed policy");
  return policy;
};
async function waitUsage(
  host: ReturnType<typeof createBrandAccountService>,
  status: BrandAccountSnapshot["usage"]["status"],
) {
  if ((await host.service.getSnapshot()).usage.status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      listener.dispose();
      reject(new Error(`Usage did not become ${status}`));
    }, 5000);
    const listener = host.service.onDidChange((snapshot) => {
      if (snapshot.usage.status !== status) return;
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    });
    void host.service.getSnapshot().then((snapshot) => {
      if (snapshot.usage.status !== status) return;
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    });
  });
}
const resolvePolicy = (
  host: ReturnType<typeof createBrandAccountService>,
  policy: Awaited<ReturnType<typeof configured>>,
) =>
  host.inference.resolve({
    providerId: policy.providerId,
    modelId: policy.defaultSelection!.modelId,
    modelConfigRevision: managedModelConfigFingerprint(
      policy.models.find((item) => item.modelId === policy.defaultSelection!.modelId)!.modelConfig,
    ),
    managedAccess: { credentialRef: policy.credentialRef, billingBinding: policy.billingBinding },
  });

test("MI07/09/11 partial: logout immediately blocks pending bootstrap; initialize singleflight", async () => {
  const f = await setup();
  const host = f.host();
  const events: BrandAccountSnapshot[] = [];
  host.service.onDidChange((snapshot) => events.push(snapshot));
  const gate = { started: latch(), finish: latch() };
  f.gateway.state.bootstrapGate = gate;
  try {
    await host.service.login(login(1));
    await gate.started.promise;
    await Promise.all([host.service.initialize(), host.service.initialize()]);
    assert.equal((await host.service.getSnapshot()).inference.status, "connecting");
    assert.equal(host.inference.getPolicy().state, "blocked");
    await host.service.logout();
    gate.finish.release();
    assert.equal((await host.service.getSnapshot()).status, "signedOut");
    assert.equal((await host.service.getSnapshot()).inference.status, "signedOut");
    assert.equal(host.inference.getPolicy().state, "blocked");
    assert.equal(
      f.gateway.state.requests.filter((request) => request.path === "/api/v1/desktop/bootstrap")
        .length,
      1,
    );
    const publicData = JSON.stringify(events);
    for (const secret of MI_SECRETS) assert(!publicData.includes(secret));
    const persisted = await readFile(f.filePath, "utf8");
    for (const secret of MI_SECRETS) assert(!persisted.includes(secret));
  } finally {
    gate.finish.release();
    await f.close();
  }
});

test("MI07 late-result fence: private coordinator rejects completed old-account bootstrap", async () => {
  const module = new URL(
    "../../../../../../services/src/brand-account/managedInference.ts",
    import.meta.url,
  ).href;
  const { createManagedInference } = (await import(
    module
  )) as typeof import("../../../../../../services/src/brand-account/managedInference.js");
  let current = { origin: "https://example.invalid", accountRef: "1", accountEpoch: 1 };
  const gate = { started: latch(), finish: latch() };
  const coordinator = createManagedInference({
    enabled: true,
    getAuthorizationGeneration: () => 0,
    readIdentity: async () => current,
    bootstrap: async () => {
      const identity = { ...current };
      gate.started.release();
      await gate.finish.promise;
      return { data: {}, identity };
    },
    onSnapshot: () => {},
  });
  try {
    const pending = coordinator.connect();
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "session_changed",
    );
    await gate.started.promise;
    coordinator.invalidate();
    current = { ...current, accountRef: "2", accountEpoch: 2 };
    gate.finish.release();
    await rejected;
    assert.equal(coordinator.host.getPolicy().state, "blocked");
  } finally {
    gate.finish.release();
    coordinator.dispose();
  }
});

test("MI07/08/11/14: A authorization cannot charge B; old epoch remains rejected after same-account login", async () => {
  const f = await setup();
  const host = f.host();
  try {
    await host.service.login(login(1));
    const a = await configured(host);
    const authA = await resolvePolicy(host, a);
    assert.equal(authA.apiKey, "E2E_MI_AGENT_1");
    assert.match(authA.accountScope, /^[a-f0-9]{64}$/u);
    const parsedAuth = zcodeProviderRuntimeHeadersResponseSchema.parse({
      headersApplied: true,
      requestAuth: authA,
    });
    assert(parsedAuth.headersApplied);
    assert.deepEqual(parsedAuth.requestAuth, authA);
    await host.service.login(login(2));
    const b = await configured(host);
    assert.notEqual(a.billingBinding.accountRef, b.billingBinding.accountRef);
    await assert.rejects(resolvePolicy(host, a));
    const authB = await resolvePolicy(host, b);
    assert.equal(authB.apiKey, "E2E_MI_AGENT_2");
    assert.match(authB.accountScope, /^[a-f0-9]{64}$/u);
    assert.notEqual(authA.accountScope, authB.accountScope);
    await assert.rejects(
      host.inference.resolve({
        providerId: "residual-personal",
        modelId: a.defaultSelection!.modelId,
        managedAccess: { credentialRef: b.credentialRef, billingBinding: b.billingBinding },
      }),
    );
    await assert.rejects(
      host.inference.resolve({
        providerId: b.providerId,
        modelId: "official-model-pin",
        managedAccess: { credentialRef: b.credentialRef, billingBinding: b.billingBinding },
      }),
    );
    await host.service.logout();
    await assert.rejects(resolvePolicy(host, b));
    await host.service.login(login(1));
    const nextA = await configured(host);
    assert.notEqual(a.billingBinding.accountEpoch, nextA.billingBinding.accountEpoch);
    await assert.rejects(resolvePolicy(host, a));
    const nextAuthA = await resolvePolicy(host, nextA);
    assert.equal(nextAuthA.apiKey, "E2E_MI_AGENT_1");
    assert.equal(
      nextAuthA.accountScope,
      authA.accountScope,
      "Account scope stays stable across same-account epoch changes",
    );
    assert.equal(
      f.gateway.state.modelRequests.length,
      0,
      "Resolver verification must not silently perform paid inference",
    );
    const publicData = JSON.stringify({
      snapshot: await host.service.getSnapshot(),
      policy: host.inference.getPolicy(),
    });
    for (const secret of MI_SECRETS) assert(!publicData.includes(secret));
  } finally {
    await f.close();
  }
});

test("MI03/10: disabled or blocked bootstrap cannot become configured or recreate credentials", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.bootstrapStatus = "credential_blocked";
    await host.service.login(login(1));
    await host.service.initialize();
    await waitInference(host, "unavailable");
    assert.equal((await host.service.getSnapshot()).status, "authenticated");
    assert.equal((await host.service.getSnapshot()).inference.status, "unavailable");
    assert.equal(host.inference.getPolicy().state, "blocked");
    await assert.rejects(host.inference.assertConfigured());
    assert.equal(
      f.gateway.state.requests.some((request) => request.path.includes("/keys")),
      false,
    );
    assert.equal(f.gateway.state.modelRequests.length, 0);
    assert.equal(f.gateway.state.violations.length, 0);
  } finally {
    await f.close();
  }
});

test("MI14: bootstrap cannot extend trusted origin or hide credentials in its API base", async () => {
  const f = await setup();
  const host = f.host();
  try {
    for (const baseUrl of [
      "https://untrusted.example.invalid/v1",
      `${f.gateway.baseUrl}/v1?api_key=E2E_MI_AGENT_1`,
      `${f.gateway.baseUrl}/v1/responses`,
    ]) {
      f.gateway.state.overrideApiBase = baseUrl;
      await host.service.login(login(1));
      await waitInference(host, "unavailable");
      assert.equal(host.inference.getPolicy().state, "blocked");
      assert.equal((await host.service.getSnapshot()).inference.error?.code, "invalid_response");
      await host.service.logout();
    }
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("MI09: two Host instances share login tombstones while inference material stays local", async () => {
  const f = await setup();
  const first = f.host();
  const second = f.host();
  try {
    await first.service.login(login(1));
    const firstA = await configured(first);
    const secondA = await configured(second);
    assert.deepEqual(firstA.billingBinding, secondA.billingBinding);
    assert.equal((await resolvePolicy(second, secondA)).apiKey, "E2E_MI_AGENT_1");
    await first.service.logout();
    // 即使第二Host的UI尚未收到watch投影，私有resolver必须重读共享账户权威并拒绝旧授权。
    await assert.rejects(resolvePolicy(second, secondA));
    await waitInference(second, "signedOut");
    await first.service.login(login(2));
    const firstB = await configured(first);
    const secondB = await configured(second);
    assert.deepEqual(firstB.billingBinding, secondB.billingBinding);
    assert.notEqual(firstA.billingBinding.accountRef, secondB.billingBinding.accountRef);
    await assert.rejects(resolvePolicy(second, firstA));
    assert.equal((await resolvePolicy(second, secondB)).apiKey, "E2E_MI_AGENT_2");
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("MI14: invalid model contract cannot open an unusable or contradictory managed model", async () => {
  const f = await setup();
  const host = f.host();
  try {
    for (const candidate of [
      { model: { max_output_tokens: 128000 }, selection: null },
      { model: { supports_streaming: false }, selection: null },
      {
        model: {
          supports_reasoning: true,
          reasoning_levels: ["high", "low"],
          default_reasoning: "high",
        },
        selection: { reasoning_level: "high" },
      },
    ]) {
      f.gateway.state.overrideModel = candidate.model;
      f.gateway.state.overrideSelection = candidate.selection;
      await host.service.login(login(1));
      await waitInference(host, "unavailable");
      assert.equal(host.inference.getPolicy().state, "blocked");
      assert.equal((await host.service.getSnapshot()).inference.error?.code, "invalid_response");
      await host.service.logout();
    }
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("MI09: logout intent blocks bootstrap revival while another Host owns the login-store lock", async () => {
  const module = new URL(
    "../../../../../../services/src/brand-account/secretRepo.ts",
    import.meta.url,
  ).href;
  const { createSecretRepo } = (await import(
    module
  )) as typeof import("../../../../../../services/src/brand-account/secretRepo.js");
  const f = await setup();
  const host = f.host();
  const blocker = createSecretRepo({
    filePath: f.filePath,
    origin: f.gateway.baseUrl,
    ...f.cipher,
  });
  const lock = { started: latch(), finish: latch() };
  const me = { started: latch(), finish: latch() };
  let held: Promise<void> | undefined;
  let loggingOut: Promise<BrandAccountSnapshot> | undefined;
  try {
    await host.service.login(login(1));
    const policy = await configured(host);
    const before = f.gateway.state.requests.filter(
      (request) => request.path === "/api/v1/desktop/bootstrap",
    ).length;
    f.gateway.state.meGate = me;
    const oldBalance = host.service.refreshBalance();
    await me.started.promise;
    held = blocker.withLock(async () => {
      lock.started.release();
      await lock.finish.promise;
    });
    await lock.started.promise;
    loggingOut = host.service.logout();
    assert.equal(host.inference.getPolicy().state, "blocked");
    const initializing = host.service.initialize();
    me.finish.release();
    await Promise.all([oldBalance, initializing]);
    // 公共读取在退出尚未提交时也必须保持本机barrier，不读取旧登录对恢复推理。
    await host.service.initialize();
    await assert.rejects(host.inference.assertConfigured());
    await assert.rejects(resolvePolicy(host, policy));
    assert.equal(host.inference.getPolicy().state, "blocked");
    assert.notEqual((await host.service.getSnapshot()).inference.status, "configured");
    assert.equal(
      f.gateway.state.requests.filter((request) => request.path === "/api/v1/desktop/bootstrap")
        .length,
      before,
    );
    lock.finish.release();
    await held;
    await loggingOut;
    assert.equal((await host.service.getSnapshot()).status, "signedOut");
    assert.equal(host.inference.getPolicy().state, "blocked");
  } finally {
    me.finish.release();
    lock.finish.release();
    await held;
    await loggingOut;
    blocker.dispose();
    await f.close();
  }
});

for (const entry of ["resolve", "assertConfigured", "readUsageScope"] as const) {
  test(
    `MI09: ${entry} rejects refresh crossing its final async identity check`,
    { timeout: 10_000 },
    async () => {
      const f = await setup();
      const host = f.host();
      const refreshRead = latch();
      const authorizationRead = latch();
      const releaseRefresh = latch();
      const releaseAuthorization = latch();
      const markerStarted = latch();
      const releaseMarker = latch();
      let markerWriting = false;
      let reads = 0;
      let refreshing: Promise<unknown> | undefined;
      try {
        await host.service.login(login(1));
        const policy = await configured(host);
        await host.service.refreshBalance();
        const outer = JSON.parse(await readFile(f.filePath, "utf8"));
        const session = JSON.parse(await f.cipher.decrypt(outer.ciphertext));
        session.credentials.expiresAt = Date.now() - 1;
        outer.ciphertext = await f.cipher.encrypt(JSON.stringify(session));
        await writeFile(f.filePath, JSON.stringify(outer));
        f.io.beforeDecrypt = async () => {
          reads += 1;
          if (reads === 3) {
            refreshRead.release();
            await releaseRefresh.promise;
          }
          if (reads === 4) {
            authorizationRead.release();
            await releaseAuthorization.promise;
          }
        };
        f.io.beforeEncrypt = async (value) => {
          if (JSON.parse(value).refreshUncertain) {
            markerWriting = true;
            markerStarted.release();
            await releaseMarker.promise;
          }
        };
        refreshing = host.service.refreshBalance().catch(() => {});
        await refreshRead.promise;
        const authorization =
          entry === "resolve"
            ? resolvePolicy(host, policy)
            : entry === "assertConfigured"
              ? host.inference.assertConfigured()
              : host.inference.readUsageScope();
        const outcome = authorization.then(
          () => ({ rejected: false, code: undefined, duringMarker: markerWriting }),
          (error: { code?: string }) => ({
            rejected: true,
            code: error.code,
            duringMarker: markerWriting,
          }),
        );
        await authorizationRead.promise;
        // 先让授权读完成，再让refresh置pending并卡在墓碑加密：同一账户epoch、ready
        // 策略均未改变，只有同步IO代次能封住await continuation返回旧授权的窗口。
        releaseAuthorization.release();
        releaseRefresh.release();
        await markerStarted.promise;
        assert.deepEqual(await outcome, {
          rejected: true,
          code: "session_changed",
          duringMarker: true,
        });
        assert.equal(host.inference.getPolicy().state, "ready");
        assert.equal(f.gateway.state.refreshes, 0);
      } finally {
        releaseAuthorization.release();
        releaseRefresh.release();
        releaseMarker.release();
        await refreshing;
        await f.close();
      }
    },
  );
}

test("MI09: first bootstrap 401 rotates login once and retries only that bootstrap", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.bootstrapRejectOnce = true;
    await host.service.login(login(1));
    await waitInference(host, "configured");
    await host.inference.assertConfigured();
    assert.equal(f.gateway.state.refreshes, 1);
    assert.equal(
      f.gateway.state.requests.filter((request) => request.path === "/api/v1/desktop/bootstrap")
        .length,
      2,
    );
    assert.equal(
      f.gateway.state.requests.filter((request) => request.path === "/api/v1/auth/login").length,
      1,
    );
    assert.equal(
      f.gateway.state.requests.some(
        (request) => request.method === "POST" && request.path.startsWith("/api/v1/payment/"),
      ),
      false,
    );
    assert.equal(f.gateway.state.modelRequests.length, 0);
    assert.equal((await host.service.getSnapshot()).status, "authenticated");
  } finally {
    await f.close();
  }
});

test("MI10: already expired inference material cannot become configured or pass private admission", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.credentialExpiresAt = "2000-01-01T00:00:00Z";
    await host.service.login(login(1));
    await waitInference(host, "unavailable");
    await assert.rejects(host.inference.assertConfigured());
    assert.equal(host.inference.getPolicy().state, "blocked");
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("MI10: configured credential expiry blocks next admission and publishes unavailable", async (context) => {
  const f = await setup();
  const host = f.host();
  try {
    const now = Date.now();
    f.gateway.state.credentialExpiresAt = new Date(now + 60_000).toISOString();
    await host.service.login(login(1));
    const policy = await configured(host);
    context.mock.timers.enable({ apis: ["Date"], now });
    context.mock.timers.setTime(now + 60_001);
    await assert.rejects(host.inference.assertConfigured());
    assert.equal(host.inference.getPolicy().state, "blocked");
    assert.equal((await host.service.getSnapshot()).inference.status, "unavailable");
    await assert.rejects(resolvePolicy(host, policy));
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    context.mock.timers.reset();
    await f.close();
  }
});

test("MI12: real usage HTTP keeps int64 precision, legacy charge, stale rows and account fences", async () => {
  const f = await setup();
  const host = f.host();
  const gate = { started: latch(), finish: latch() };
  try {
    await host.service.login(login(1));
    await waitInference(host, "configured");
    await waitUsage(host, "fresh");
    const initial = (await host.service.getSnapshot()).usage;
    assert.deepEqual(initial.items[0]!.charge, {
      kind: "credits",
      credits: "9007199254740993",
      creditsPerUsd: "1000000000",
      usdDecimal: "9007199.254740993",
      precision: "exact",
    });
    assert.deepEqual(initial.items[1]!.charge, { kind: "legacy", actualCostUsd: 0.0123 });
    f.gateway.state.usageFails = true;
    const failed = await host.service.refreshBalance();
    assert.equal(failed.usage.status, "stale");
    assert.deepEqual(failed.usage.items, initial.items);
    f.gateway.state.usageFails = false;
    f.gateway.state.usageGate = gate;
    const lateA = host.service.refreshBalance();
    await gate.started.promise;
    await host.service.login(login(2));
    await waitInference(host, "configured");
    await waitUsage(host, "fresh");
    assert(
      (await host.service.getSnapshot()).usage.items.every((item) => item.requestId.endsWith("_2")),
    );
    gate.finish.release();
    await lateA;
    assert(
      (await host.service.getSnapshot()).usage.items.every((item) => item.requestId.endsWith("_2")),
      "Late A usage cannot replace B records",
    );
    f.gateway.state.usageEmpty = true;
    const empty = await host.service.refreshBalance();
    assert.equal(empty.usage.status, "fresh");
    assert.deepEqual(empty.usage.items, []);
    assert.equal(f.gateway.state.violations.length, 0, JSON.stringify(f.gateway.state.violations));
  } finally {
    gate.finish.release();
    await f.close();
  }
});

const multiModels = () => [
  {
    id: MI_MODEL,
    display_name: "E2E first",
    context_window: 128000,
    max_output_tokens: 8192,
    default_max_output_tokens: 4096,
    reasoning_levels: ["none"],
    default_reasoning: "none",
    supports_reasoning: false,
    supports_streaming: true,
    requires_mfjs_tool_schema: false,
    input: { text: true, image: false, video: false, audio: false, pdf: false },
    output: { text: true },
    supports_tool_call: true,
    supports_json_schema_output: false,
    supports_native_web_search: false,
    supports_mid_conversation_system: true,
  },
  {
    id: "e2e-second",
    display_name: "E2E second",
    context_window: 256000,
    max_output_tokens: 32000,
    default_max_output_tokens: 16000,
    reasoning_levels: ["low", "high"],
    default_reasoning: "low",
    supports_reasoning: true,
    supports_streaming: true,
    requires_mfjs_tool_schema: false,
    input: { text: true, image: true, video: false, audio: false, pdf: true },
    output: { text: true },
    supports_tool_call: true,
    supports_json_schema_output: true,
    supports_native_web_search: false,
    supports_mid_conversation_system: true,
  },
];

test("MM01/03: protocol2 applies two independent models and revokes removed members on reconnect", async () => {
  const f = await setup();
  let host = f.host();
  try {
    f.gateway.state.overrideModels = multiModels();
    f.gateway.state.overrideSelection = {
      model_id: "e2e-second",
      reasoning_level: "low",
      max_output_tokens: 16000,
    };
    await host.service.login(login(1));
    const policy = await configured(host);
    assert.equal(policy.defaultSelection!.modelId, "e2e-second");
    assert.equal(policy.models.length, 2);
    const resolution = resolveManagedProviderPolicy(policy);
    assert.deepEqual(
      resolution.registryProviders[0]?.models.map((m) => m.modelId),
      [MI_MODEL, "e2e-second"],
    );
    assert.equal(policy.models[0]?.modelConfig.optionSpecs.maxOutputTokens.max, 4096);
    assert.equal(policy.models[1]?.modelConfig.optionSpecs.maxOutputTokens.max, 16000);
    assert.deepEqual(policy.models[1]?.modelConfig.optionSpecs.reasoningLevel.values, [
      "low",
      "high",
    ]);
    assert.equal(policy.models[0]?.modelConfig.optionSpecs.reasoningLevel.defaultLevel, "none");
    assert.equal(policy.models[1]?.modelConfig.optionSpecs.reasoningLevel.defaultLevel, "low");
    assert.equal(
      resolution.registryProviders[0]?.models[1]?.config.optionSpecs.reasoningLevel.defaultLevel,
      "low",
    );
    const resolve = (modelId: string, current = policy) =>
      host.inference.resolve({
        providerId: current.providerId,
        modelId,
        modelConfigRevision: managedModelConfigFingerprint(
          current.models.find((item) => item.modelId === modelId)?.modelConfig ??
            current.models[0]!.modelConfig,
        ),
        managedAccess: {
          credentialRef: current.credentialRef,
          billingBinding: current.billingBinding,
        },
      });
    for (const id of [MI_MODEL, "e2e-second"])
      assert.equal((await resolve(id)).apiKey, "E2E_MI_AGENT_1");
    await assert.rejects(resolve("not-configured"));
    f.gateway.state.overrideModels = [multiModels()[1]!];
    f.gateway.state.configRevision = "e2e-mi-2";
    host.dispose();
    host = f.host();
    const updated = await configured(host);
    assert.equal(updated.models.length, 1);
    assert.notEqual(updated.revision, policy.revision);
    await assert.rejects(resolve(MI_MODEL));
    await assert.rejects(resolve(MI_MODEL, updated));
    assert.equal((await resolve("e2e-second", updated)).apiKey, "E2E_MI_AGENT_1");
    assert.equal(f.gateway.state.modelRequests.length, 0);
    assert.equal(f.gateway.state.violations.length, 0);
  } finally {
    await f.close();
  }
});

test("MM02: duplicate IDs, absent default and invalid nondefault member reject the entire policy", async () => {
  const f = await setup();
  const host = f.host();
  try {
    for (const invalid of [
      [multiModels()[0]!, multiModels()[0]!],
      [multiModels()[1]!],
      [multiModels()[0]!, { ...multiModels()[1]!, max_output_tokens: 256000 }],
      [multiModels()[0]!, { ...multiModels()[1]!, supports_tool_call: false }],
    ]) {
      f.gateway.state.overrideModels = invalid;
      await host.service.login(login(1));
      await waitInference(host, "unavailable");
      assert.equal(host.inference.getPolicy().state, "blocked");
      assert.equal((await host.service.getSnapshot()).inference.error?.code, "invalid_response");
      await host.service.logout();
    }
    f.gateway.state.schemaVersion = 1;
    f.gateway.state.overrideModels = multiModels();
    await host.service.login(login(1));
    await waitInference(host, "unavailable");
    await host.service.logout();
    f.gateway.state.overrideModels = [multiModels()[0]!];
    await host.service.login(login(1));
    assert.equal((await configured(host)).models.length, 1);
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("MR01/02/03/04: online singleflight, compatible updates, deletion and frozen config guard", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.schemaVersion = 3;
    f.gateway.state.overrideModels = multiModels();
    await host.service.login(login(1));
    const original = await configured(host);
    let changes = 0;
    const stop = host.inference.onDidChange(() => {
      changes += 1;
    });
    const before = f.gateway.state.requests.filter(
      (r) => r.path === "/api/v1/desktop/bootstrap",
    ).length;
    await Promise.all(
      Array.from({ length: 8 }, () => host.service.refreshAgentConfig({ force: true })),
    );
    assert.equal(
      f.gateway.state.requests.filter((r) => r.path === "/api/v1/desktop/bootstrap").length -
        before,
      1,
    );
    assert.equal(changes, 0, "Identical bootstrap must not publish a new policy");
    f.gateway.state.overrideModels = multiModels().map((item) => ({
      ...item,
      display_name: `Renamed ${item.id}`,
    }));
    f.gateway.state.overrideSelection = {
      model_id: "e2e-second",
      reasoning_level: "low",
      max_output_tokens: 16000,
    };
    f.gateway.state.configRevision = "catalog-two";
    await host.service.refreshAgentConfig({ force: true });
    const renamed = await configured(host);
    assert.deepEqual(original.billingBinding, renamed.billingBinding);
    assert.equal((await resolvePolicy(host, original)).apiKey, "E2E_MI_AGENT_1");
    assert.equal(renamed.defaultSelection!.modelId, "e2e-second");
    assert.equal(renamed.models[0]!.displayName, `Renamed ${MI_MODEL}`);
    f.gateway.state.overrideModels = [multiModels()[1]!];
    await host.service.refreshAgentConfig({ force: true });
    await assert.rejects(resolvePolicy(host, original), { code: "model_unavailable" });
    assert.equal((await resolvePolicy(host, renamed)).apiKey, "E2E_MI_AGENT_1");
    f.gateway.state.overrideModels = [{ ...multiModels()[1]!, default_max_output_tokens: 8000 }];
    f.gateway.state.overrideSelection = {
      model_id: "e2e-second",
      reasoning_level: "low",
      max_output_tokens: 8000,
    };
    await host.service.refreshAgentConfig({ force: true });
    await assert.rejects(resolvePolicy(host, renamed), { code: "model_configuration_changed" });
    assert.equal((await resolvePolicy(host, await configured(host))).apiKey, "E2E_MI_AGENT_1");
    f.gateway.state.authorizationScope = "b".repeat(64);
    await host.service.refreshAgentConfig({ force: true });
    // 新输入只核对账号，刷新后冻结新scope；已冻结旧请求仍不得取Key。
    await host.inference.assertAdmissionIdentity({
      credentialRef: original.credentialRef,
      billingBinding: original.billingBinding,
    });
    await assert.rejects(resolvePolicy(host, renamed));
    await assert.rejects(
      host.inference.assertAdmissionIdentity({
        credentialRef: original.credentialRef,
        billingBinding: {
          ...original.billingBinding,
          accountEpoch: original.billingBinding.accountEpoch + 1,
        },
      }),
      { code: "session_changed" },
    );
    await assert.rejects(
      host.inference.assertAdmissionIdentity({
        credentialRef: original.credentialRef,
        billingBinding: { ...original.billingBinding, accountRef: "another-account" },
      }),
      { code: "session_changed" },
    );
    stop();
  } finally {
    await f.close();
  }
});

test("MR05/08: transient sync failure retains policy and existing attempts; stale new turn waits", async (context) => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.schemaVersion = 3;
    await host.service.login(login(1));
    const policy = await configured(host);
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    context.mock.timers.tick(61_000);
    for (const status of [503, 429]) {
      f.gateway.state.bootstrapFailureStatus = status;
      await assert.rejects(host.service.refreshAgentConfig({ force: true }));
      const snapshot = await host.service.getSnapshot();
      assert.equal(snapshot.inference.status, "configured");
      assert(snapshot.inference.refreshError);
      assert.deepEqual(host.inference.getPolicy(), policy);
      assert.equal((await resolvePolicy(host, policy)).apiKey, "E2E_MI_AGENT_1");
      await assert.rejects(host.inference.ensureFreshForAdmission());
    }
    f.gateway.state.bootstrapFailureStatus = 0;
    f.gateway.state.overrideModel = { supports_tool_call: false };
    await assert.rejects(host.service.refreshAgentConfig({ force: true }));
    assert.equal(
      (await host.service.getSnapshot()).inference.refreshError?.code,
      "invalid_response",
    );
    assert.equal((await resolvePolicy(host, policy)).apiKey, "E2E_MI_AGENT_1");
    f.gateway.state.overrideModel = null;
    await host.service.refreshAgentConfig({ force: true });
    await host.inference.ensureFreshForAdmission();
    assert.equal((await host.service.getSnapshot()).inference.refreshError, null);
    const beforeBalance = f.gateway.state.requests.filter(
      (r) => r.path === "/api/v1/desktop/bootstrap",
    ).length;
    await host.service.refreshBalance();
    assert.equal(
      f.gateway.state.requests.filter((r) => r.path === "/api/v1/desktop/bootstrap").length,
      beforeBalance,
    );
  } finally {
    context.mock.timers.reset();
    await f.close();
  }
});

test("MR06/07: v3 nullable default and empty effective catalog never fall back; confirmed key block clears", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.schemaVersion = 3;
    f.gateway.state.overrideModels = multiModels();
    await host.service.login(login(1));
    const original = await configured(host);
    f.gateway.state.overrideModels = [multiModels()[1]!];
    f.gateway.state.noDefault = true;
    f.gateway.state.unavailableModels = [
      { model_id: MI_MODEL, display_name: "Removed default", reason_code: "model_unavailable" },
    ];
    await host.service.refreshAgentConfig({ force: true });
    const partial = await configured(host);
    assert.equal(partial.defaultSelection, null);
    assert.equal(partial.models.length, 1);
    await assert.rejects(resolvePolicy(host, original), { code: "model_unavailable" });
    f.gateway.state.overrideModels = [];
    f.gateway.state.unavailableModels.push({
      model_id: "e2e-second",
      display_name: "Second",
      reason_code: "reasoning_policy_changed",
    });
    await host.service.refreshAgentConfig({ force: true });
    const empty = await configured(host);
    assert.deepEqual(empty.models, []);
    assert.equal(empty.defaultSelection, null);
    assert.equal(
      resolveManagedProviderPolicy(empty).registryProviders.every(
        (provider) => provider.models.length === 0,
      ),
      true,
    );
    f.gateway.state.bootstrapStatus = "credential_blocked";
    await assert.rejects(host.service.refreshAgentConfig({ force: true }));
    assert.equal(host.inference.getPolicy().state, "blocked");
    await assert.rejects(host.inference.assertConfigured());
  } finally {
    await f.close();
  }
});

test("MR06: failed logout storage releases its intent barrier and permits an explicit retry", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.schemaVersion = 3;
    await host.service.login(login(1));
    await configured(host);
    f.io.beforeEncrypt = async (value) => {
      if (!JSON.parse(value).credentials) throw new Error("synthetic cipher failure");
    };
    await assert.rejects(host.service.logout(), { code: "storage_unavailable" });
    assert.equal((await host.service.getSnapshot()).error?.code, "storage_unavailable");
    assert.equal((await host.service.getSnapshot()).status, "authenticated");
    f.io.beforeEncrypt = undefined;
    await host.service.refreshAgentConfig({ force: true });
    await host.inference.assertConfigured();
    await host.service.logout();
    assert.equal((await host.service.getSnapshot()).status, "signedOut");
  } finally {
    await f.close();
  }
});

test("MR05: temporary wallet outage does not prevent independent model initialization", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.schemaVersion = 3;
    f.gateway.state.meFailureStatus = 503;
    await assert.rejects(host.service.login(login(1)));
    // configured()包含initialize/余额读取；此处只观察独立推理初始化，避免让故障夹具自相矛盾。
    await waitInference(host, "configured");
    await host.inference.assertConfigured();
    assert.equal((await host.service.getSnapshot()).wallet.status, "unavailable");
    f.gateway.state.meFailureStatus = 0;
    await host.service.refreshBalance();
    assert.equal((await host.service.getSnapshot()).wallet.status, "fresh");
  } finally {
    await f.close();
  }
});

test("MR02/05: configuration save races retry once and never clear a valid running policy", async () => {
  const f = await setup();
  const host = f.host();
  try {
    f.gateway.state.schemaVersion = 3;
    await host.service.login(login(1));
    const policy = await configured(host);
    let changes = 0;
    host.inference.onDidChange(() => {
      changes += 1;
    });
    const count = () =>
      f.gateway.state.requests.filter((r) => r.path === "/api/v1/desktop/bootstrap").length;
    f.gateway.state.configurationChangedResponses = 1;
    const before = count();
    await host.service.refreshAgentConfig({ force: true });
    assert.equal(count() - before, 2);
    assert.equal(changes, 0);
    f.gateway.state.configurationChangedResponses = 5;
    const repeated = count();
    await assert.rejects(host.service.refreshAgentConfig({ force: true }));
    assert.equal(count() - repeated, 2, "Repeated saves cannot create an unbounded retry loop");
    assert.equal(host.inference.getPolicy().state, "ready");
    assert.equal((await resolvePolicy(host, policy)).apiKey, "E2E_MI_AGENT_1");
    assert.equal(changes, 0);
  } finally {
    await f.close();
  }
});

const candidate = (policy: Awaited<ReturnType<typeof configured>>, key = "E2E_MI_AGENT_1") => ({
  kind: "credential_rejected_candidate" as const,
  managedAccess: { credentialRef: policy.credentialRef, billingBinding: policy.billingBinding },
  credentialFingerprint: createHash("sha256").update(key).digest("hex"),
});

test("RC01: bootstrap exposes only fixed safe reasons and preserves account login", async () => {
  const f = await setup();
  const host = f.host();
  const reasons = [
    "service_disabled",
    "service_not_configured",
    "account_forbidden",
    "group_unavailable",
    "group_forbidden",
    "credential_disabled",
    "credential_expired",
    "credential_quota_exhausted",
    "configuration_invalid",
  ];
  try {
    await host.service.login(login(1));
    await configured(host);
    f.gateway.state.bootstrapStatus = "credential_blocked";
    for (const reason of [
      ...reasons,
      "unknown_sensitive_backend_reason",
      "constructor",
      "__proto__",
    ]) {
      f.gateway.state.bootstrapReason =
        new Map([
          ["service_disabled", "disabled"],
          ["service_not_configured", "configuration_missing"],
          ["account_forbidden", "user_forbidden"],
        ]).get(reason) ?? reason;
      await assert.rejects(host.service.refreshAgentConfig({ force: true }));
      const value = await host.service.getSnapshot();
      assert.equal(
        value.inference.error?.code,
        reasons.includes(reason) ? reason : "inference_unavailable",
      );
      assert.equal(value.status, "authenticated");
      assert(!JSON.stringify(value).includes("unknown_sensitive_backend_reason"));
    }
  } finally {
    await f.close();
  }
});

test("RC02/03: auth candidates coalesce bootstrap, ignore rotated keys/scopes and never call model", async () => {
  const f = await setup();
  const host = f.host();
  const gate = { started: latch(), finish: latch() };
  const count = () =>
    f.gateway.state.requests.filter((r) => r.path === "/api/v1/desktop/bootstrap").length;
  try {
    f.gateway.state.schemaVersion = 3;
    await host.service.login(login(1));
    const policy = await configured(host);
    const before = count();
    f.gateway.state.bootstrapGate = gate;
    const reports = Promise.all(
      Array.from({ length: 8 }, () => host.inference.reportOutcome(candidate(policy))),
    );
    await gate.started.promise;
    assert.equal(count(), before + 1);
    f.gateway.state.credentialKey = "E2E_MI_AGENT_1_ROTATED";
    gate.finish.release();
    await reports;
    assert.equal((await resolvePolicy(host, policy)).apiKey, "E2E_MI_AGENT_1_ROTATED");
    await host.inference.reportOutcome(candidate(policy));
    await host.inference.reportOutcome(
      candidate(
        {
          ...policy,
          billingBinding: {
            ...policy.billingBinding,
            policyRevision: "stale-scope",
          },
        },
        "E2E_MI_AGENT_1_ROTATED",
      ),
    );
    assert.equal(count(), before + 1);
    // 同名上游401仅触发控制面确认，控制面ready不能清登录或阻断。
    await host.inference.reportOutcome(candidate(policy, "E2E_MI_AGENT_1_ROTATED"));
    assert.equal(count(), before + 2);
    assert.equal((await host.service.getSnapshot()).status, "authenticated");
    assert.equal(host.inference.getPolicy().state, "ready");
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    gate.finish.release();
    await f.close();
  }
});

test("RC05: settlement tails both pre-event reads and another event during the tail", async (context) => {
  const f = await setup();
  const host = f.host();
  const first = { started: latch(), finish: latch() };
  const firstUsage = { started: latch(), finish: latch() };
  const tail = { started: latch(), finish: latch() };
  const tailUsage = { started: latch(), finish: latch() };
  try {
    await host.service.login(login(1));
    const policy = await configured(host);
    await waitUsage(host, "fresh");
    const beforeMe = f.gateway.state.requests.filter((r) => r.path === "/api/v1/auth/me").length;
    const beforeUsage = f.gateway.state.requests.filter((r) => r.path === "/api/v1/usage").length;
    f.gateway.state.usageGate = firstUsage;
    const usageRead = host.service.refreshBalance();
    await firstUsage.started.promise;
    f.gateway.state.meGate = first;
    // 分开启动旧余额/用量读取，模拟事件到来时两者都在途。
    const balanceRead = host.service.refreshBalance();
    await first.started.promise;
    await host.inference.reportOutcome({
      kind: "turn_settled",
      billingBinding: policy.billingBinding,
    });
    f.gateway.state.balanceOverride = 10;
    f.gateway.state.meGate = tail;
    first.finish.release();
    await tail.started.promise;
    f.gateway.state.usageGate = tailUsage;
    firstUsage.finish.release();
    await tailUsage.started.promise;
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2000 });
    const queued = new Promise<void>((resolve) => {
      const subscription = host.service.onDidChange(() => {
        subscription.dispose();
        resolve();
      });
    });
    await host.inference.reportOutcome({
      kind: "turn_settled",
      billingBinding: policy.billingBinding,
    });
    // 两个HTTP均被gate阻挡；此事件仅来自结算后balance尾随读的排队。
    await queued;
    f.gateway.state.balanceOverride = 8;
    f.gateway.state.usageEmpty = true;
    tail.finish.release();
    tailUsage.finish.release();
    await Promise.all([balanceRead, usageRead]);
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        subscription.dispose();
        reject(new Error("post-settlement snapshots not published"));
      }, 3000);
      const subscription = host.service.onDidChange((value) => {
        if (
          value.wallet.status !== "fresh" ||
          value.wallet.availableUsd !== 8 ||
          value.usage.status !== "fresh" ||
          value.usage.items.length
        )
          return;
        clearTimeout(deadline);
        subscription.dispose();
        resolve();
      });
      void host.service.getSnapshot().then((value) => {
        if (
          value.wallet.availableUsd === 8 &&
          value.usage.status === "fresh" &&
          !value.usage.items.length
        ) {
          clearTimeout(deadline);
          subscription.dispose();
          resolve();
        }
      });
    });
    assert.equal(
      f.gateway.state.requests.filter((r) => r.path === "/api/v1/auth/me").length - beforeMe,
      4,
    );
    assert.equal(
      f.gateway.state.requests.filter((r) => r.path === "/api/v1/usage").length - beforeUsage,
      3,
    );
  } finally {
    context.mock.timers.reset();
    for (const gate of [first, firstUsage, tail, tailUsage]) gate.finish.release();
    await f.close();
  }
});

test("RC06: public-settings failure does not prevent restoring stored inference session", async () => {
  const f = await setup();
  try {
    const first = f.host();
    await first.service.login(login(1));
    await configured(first);
    first.dispose();
    f.gateway.state.publicSettingsFailureStatus = 503;
    const restored = f.host();
    await assert.rejects(restored.service.initialize());
    await waitInference(restored, "configured");
    await restored.inference.assertConfigured();
    assert.equal((await restored.service.getSnapshot()).status, "authenticated");
    assert.equal(f.gateway.state.logins, 1);
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("RC04: confirmed disabled credential stays blocked after candidate recovery and key reset", async () => {
  const f = await setup();
  const host = f.host();
  try {
    await host.service.login(login(1));
    const policy = await configured(host);
    f.gateway.state.bootstrapStatus = "credential_blocked";
    f.gateway.state.bootstrapReason = "credential_disabled";
    await assert.rejects(host.inference.reportOutcome(candidate(policy)));
    assert.equal((await host.service.getSnapshot()).inference.error?.code, "credential_disabled");
    assert.equal((await host.service.getSnapshot()).status, "authenticated");
    f.gateway.state.credentialKey = "E2E_MI_AGENT_1_RESET_BUT_DISABLED";
    await assert.rejects(host.service.refreshAgentConfig({ force: true }));
    assert.equal(host.inference.getPolicy().state, "blocked");
    assert.equal(f.gateway.state.modelRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("RC05 account fence: old balance tail cannot pin or publish over new login", async () => {
  const f = await setup();
  const host = f.host();
  const gate = { started: latch(), finish: latch() };
  try {
    await host.service.login(login(1));
    const policy = await configured(host);
    await waitUsage(host, "fresh");
    f.gateway.state.meGate = gate;
    const old = host.service.refreshBalance().catch(() => undefined);
    await gate.started.promise;
    const queued = new Promise<void>((resolve) => {
      const subscription = host.service.onDidChange(() => {
        subscription.dispose();
        resolve();
      });
    });
    await host.inference.reportOutcome({
      kind: "turn_settled",
      billingBinding: policy.billingBinding,
    });
    await queued;
    await host.service.login(login(2));
    assert.equal((await host.service.getSnapshot()).user?.id, 2);
    gate.finish.release();
    await old;
    assert.equal((await host.service.getSnapshot()).user?.id, 2);
    assert.equal((await host.service.getSnapshot()).wallet.availableUsd, 56.78);
  } finally {
    gate.finish.release();
    await f.close();
  }
});
