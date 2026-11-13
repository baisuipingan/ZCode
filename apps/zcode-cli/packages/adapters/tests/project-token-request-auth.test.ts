import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createRegistryProviderConfig,
  parseProviderConfig,
  createRegistryModelConfig,
  parseModelConfig,
} from "@zcode/provider";
import { runWithModelInvocationContext } from "@zcode/contracts";
import { managedModelConfigFingerprint } from "@zcode/shared";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const TOKEN = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })).toString(
    "base64url",
  ),
  Buffer.from(JSON.stringify({ token_use: "project_access", sub: "test-account" })).toString(
    "base64url",
  ),
  "synthetic_signature_only_for_test",
].join(".");
const API_TYPES = ["anthropic-messages", "openai-chat-completions", "openai-responses"] as const;
const OPTIONS = { reasoningLevel: "disabled", maxOutputTokens: 64 };
const STATIC_HEADERS = [
  { Authorization: "Bearer old-key", "x-api-key": "old-key" },
  { authorization: "Bearer old-key", "X-API-KEY": "old-key" },
  { AuThOrIzAtIoN: "Bearer old-key", "X-Api-Key": "old-key" },
];

function fixture(
  apiType: (typeof API_TYPES)[number],
  access: Record<string, unknown>,
  headers: Record<string, string>,
) {
  const requests: Request[] = [];
  const execution = new AiSdkModelExecution(
    {
      env: {},
      defaultHeaders: { AUTHORIZATION: "Bearer default-old-key", "X-API-KEY": "default-old-key" },
    },
    {
      // 旧夹具依赖不完整凭据绕过校验；此处注入中性端口，安全合同由独立用例验证。
      requestSecurityState: {
        createExecution: () => ({
          protectTransport: ({ transport }) => transport,
          take: () => [],
        }),
      },
      transport: async (input, init) => {
        requests.push(new Request(input, init));
        // 捕获真实 SDK 最终请求头；不访问网络，不依赖各协议的成功响应格式。
        return Response.json(
          { error: { type: "invalid_request_error", message: "captured" } },
          { status: 400 },
        );
      },
    },
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access,
      api: { type: apiType, baseUrl: "https://model.example/api/anthropic", headers },
    }),
  );
  if (!provider.ok) throw new Error("invalid auth fixture");
  const bound = execution.bindModel({
    providerId: "auth-fixture",
    modelId: "GLM-5.3",
    providerConfig: provider.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  return { requests, bound };
}

async function capture(model: Parameters<typeof generateText>[0]["model"]) {
  await expect(generateText({ model, prompt: "test", maxRetries: 0 })).rejects.toThrow();
}

describe.each(API_TYPES)("%s 请求期账号鉴权", (apiType) => {
  it.each(["individual-coding-plan", "team-coding-plan"] as const)(
    "%s 的 PAT 覆盖静态认证头，轮换不修改绑定配置",
    async (mode) => {
      for (const stale of STATIC_HEADERS) {
        const headers = { ...stale, "X-Session-ID": "session", "X-Custom": "keep" };
        const original = { ...headers };
        const { requests, bound } = fixture(
          apiType,
          { type: "zhipu-account", accountType: "bigmodel", mode, entitled: true },
          headers,
        );
        const tokens = [TOKEN, TOKEN.replace("test", "next")];
        for (const apiKey of tokens) {
          await capture(bound.resolveRequest({ options: OPTIONS, requestAuth: { apiKey } }).model);
        }
        expect(requests).toHaveLength(2);
        requests.forEach((request, index) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${tokens[index]}`);
          expect(request.headers.get("x-api-key")).toBe(
            apiType === "anthropic-messages" ? tokens[index] : null,
          );
          expect(request.headers.get("x-session-id")).toBe("session");
          expect(request.headers.get("x-custom")).toBe("keep");
        });
        expect(headers).toEqual(original);
      }
    },
  );

  it.each(["api-key", "zhipu-coding-plan-api-key"] as const)(
    "%s 保留自定义认证头",
    async (type) => {
      // access 类型决定认证头优先级；手工 Key 必须保留调用方自定义头。
      const { requests, bound } = fixture(apiType, { type, apiKey: TOKEN }, STATIC_HEADERS[0]!);
      await capture(
        bound.resolveRequest({ options: OPTIONS, requestAuth: { apiKey: TOKEN } }).model,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer old-key");
      expect(requests[0]!.headers.get("x-api-key")).toBe("old-key");
    },
  );
});

describe("账号 owner 的动态身份头", () => {
  it("真实 runner 每次向 Host 取 managed Key；缺原绑定/换号不能使用环境或当前策略", async () => {
    const billingBinding = {
      origin: "https://model.example",
      accountRef: "user:A",
      accountEpoch: 1,
      policyRevision: "1",
    };
    const provider = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "brand-managed", credentialRef: "workbench", billingBinding },
        api: { type: "openai-responses", baseUrl: "https://model.example/v1" },
      }),
    );
    const modelConfig = createRegistryModelConfig(
      parseModelConfig({
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 128000,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        },
        optionSpecs: {
          reasoningLevel: { values: ["none"], map: "{}" },
          maxOutputTokens: { max: 100, map: "{}" },
        },
      }),
    );
    if (!provider.ok || !modelConfig.ok) throw new Error("invalid managed fixture");
    const requests: Request[] = [];
    const adapter = new AiSdkModelAdapter({
      env: { OPENAI_API_KEY: "environment-must-not-send" },
      retry: { maxAttempts: 1 },
      requestSecurityState: {
        createExecution: () => ({ protectTransport: ({ transport }) => transport, take: () => [] }),
      },
      transport: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ error: { message: "captured" } }, { status: 400 });
      },
    });
    const create = (binding?: typeof billingBinding) =>
      adapter.createModel({
        providerId: "managed",
        modelId: "model",
        providerConfig: provider.config,
        modelConfig: modelConfig.config,
        options: { reasoningLevel: "none", maxOutputTokens: 1 },
        ...(binding ? { requestDependencies: { billingBinding: binding } } : {}),
      });
    let generation = 0;
    let connected = true;
    const refresh = async (input: { managedAccess?: unknown; modelConfigRevision?: string }) => {
      expect(input.managedAccess).toEqual({ credentialRef: "workbench", billingBinding });
      expect(input.modelConfigRevision).toBe(
        managedModelConfigFingerprint(modelConfig.config.toJSON()),
      );
      if (!connected) throw new Error("account changed");
      return { headersApplied: true, requestAuth: { apiKey: `managed-${++generation}` } };
    };
    const invoke = (model: ReturnType<typeof create>) =>
      runWithModelInvocationContext({ refreshRuntimeHeadersBeforeAttempt: refresh }, () =>
        model.generateText({ messages: [{ role: "user", content: "hello" }] }),
      );
    const model = create(billingBinding);
    await expect(invoke(model)).rejects.toThrow();
    await expect(invoke(model)).rejects.toThrow();
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer managed-1",
      "Bearer managed-2",
    ]);
    connected = false;
    await expect(invoke(model)).rejects.toThrow();
    await expect(invoke(create())).rejects.toThrow();
    await expect(invoke(create({ ...billingBinding, accountRef: "user:B" }))).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });
  it.each([301, 307])(
    "brand-managed %s 跳转不发第二次请求，不把 Key 带到新路径",
    async (status) => {
      const requests: Array<{ path: string | undefined; auth: string | undefined }> = [];
      const server = createServer((request, response) => {
        requests.push({ path: request.url, auth: request.headers.authorization });
        response.writeHead(status, { location: "/escape" });
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing fixture port");
        const origin = `http://127.0.0.1:${address.port}`;
        const provider = createRegistryProviderConfig(
          parseProviderConfig({
            group: "standard-personal",
            access: {
              type: "brand-managed",
              credentialRef: "workbench",
              billingBinding: {
                origin,
                accountRef: "user:A",
                accountEpoch: 1,
                policyRevision: "1",
              },
            },
            api: { type: "openai-responses", baseUrl: `${origin}/v1` },
          }),
        );
        if (!provider.ok) throw new Error("invalid redirect fixture");
        const execution = new AiSdkModelExecution(
          { env: {} },
          {
            requestSecurityState: {
              createExecution: () => ({
                protectTransport: ({ transport }) => transport,
                take: () => [],
              }),
            },
          },
        );
        const bound = execution.bindModel({
          providerId: "managed",
          modelId: "model",
          providerConfig: provider.config,
          supportsJsonSchemaOutput: false,
          optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
        });
        await capture(
          bound.resolveRequest({
            options: OPTIONS,
            requestAuth: { apiKey: "managed-redirect-sentinel" },
          }).model,
        );
        expect(requests).toEqual([
          { path: "/v1/responses", auth: "Bearer managed-redirect-sentinel" },
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  it("brand-managed 每次动态 Key 清除静态认证头且不改变非秘密配置", async () => {
    const access = {
      type: "brand-managed",
      credentialRef: "milorouter:workbench",
      billingBinding: {
        origin: "https://model.example",
        accountRef: "user:1",
        accountEpoch: 1,
        policyRevision: "1",
      },
    };
    const { requests, bound } = fixture("openai-responses", access, STATIC_HEADERS[0]!);
    for (const apiKey of ["managed-one", "managed-two"]) {
      await capture(bound.resolveRequest({ options: OPTIONS, requestAuth: { apiKey } }).model);
    }
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer managed-one",
      "Bearer managed-two",
    ]);
    expect(requests.every((request) => request.headers.get("x-api-key") === null)).toBe(true);
    expect(JSON.stringify(access)).not.toContain("managed-one");
  });
  it.each(["start-plan", "off-peak", "highspeed"] as const)(
    "%s 保留独立 JWT 和票据头",
    async (mode) => {
      const { requests, bound } = fixture(
        "anthropic-messages",
        { type: "zhipu-account", accountType: "bigmodel", mode, entitled: true },
        STATIC_HEADERS[0]!,
      );
      await capture(
        bound.resolveRequest({
          options: OPTIONS,
          requestAuth: {
            apiKey: "runtime-jwt",
            headers: {
              Authorization: "Bearer owner-jwt",
              "X-API-KEY": "owner-key",
              "X-Off-Peak-Ticket-ID": "ticket",
            },
          },
        }).model,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer owner-jwt");
      expect(requests[0]!.headers.get("x-api-key")).toBe("owner-key");
      expect(requests[0]!.headers.get("x-off-peak-ticket-id")).toBe("ticket");
    },
  );
});

describe("托管失败仅反馈候选，不重放付费请求", () => {
  it.each([
    [401, "INVALID_API_KEY", "credential_rejected_candidate"],
    [401, "API_KEY_DISABLED", "credential_rejected_candidate"],
    [403, "INSUFFICIENT_BALANCE", "balance_rejected_candidate"],
    [401, "OTHER_UPSTREAM_CODE", undefined],
    [503, "INVALID_API_KEY", undefined],
  ] as const)("HTTP %s / %s 的 generate 和 stream 行为", async (status, code, kind) => {
    const billingBinding = {
      origin: "https://model.example",
      accountRef: "A",
      accountEpoch: 1,
      policyRevision: "scope",
    };
    const provider = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "brand-managed", credentialRef: "agent", billingBinding },
        api: { type: "openai-responses", baseUrl: "https://model.example/v1" },
      }),
    );
    const modelConfig = createRegistryModelConfig(
      parseModelConfig({
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 128000,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        },
        optionSpecs: {
          reasoningLevel: { values: ["none"], map: "{}" },
          maxOutputTokens: { max: 100, map: "{}" },
        },
      }),
    );
    if (!provider.ok || !modelConfig.ok) throw new Error("invalid managed fixture");
    for (const streaming of [false, true]) {
      const outcomes: unknown[] = [];
      const requests: Request[] = [];
      const adapter = new AiSdkModelAdapter({
        env: {},
        retry: { maxAttempts: 1 },
        requestSecurityState: {
          createExecution: () => ({
            protectTransport: ({ transport }) => transport,
            take: () => [],
          }),
        },
        transport: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(
            { error: { code, message: "synthetic upstream rejection" } },
            { status },
          );
        },
      });
      const model = adapter.createModel({
        providerId: "managed",
        modelId: "model",
        providerConfig: provider.config,
        modelConfig: modelConfig.config,
        options: { reasoningLevel: "none", maxOutputTokens: 10 },
        requestDependencies: { billingBinding },
      });
      await expect(
        runWithModelInvocationContext(
          {
            refreshRuntimeHeadersBeforeAttempt: async () => ({
              headersApplied: true,
              requestAuth: { apiKey: "test-managed-key" },
            }),
            reportManagedOutcome: (outcome) => {
              outcomes.push(outcome);
            },
          },
          async () => {
            const request = { messages: [{ role: "user" as const, content: "hello" }] };
            if (!streaming) return model.generateText(request);
            for await (const _event of model.streamText(request)) {
              /* consume real SDK stream */
            }
          },
        ),
      ).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(outcomes).toEqual(
        kind
          ? [
              {
                kind,
                managedAccess: { credentialRef: "agent", billingBinding },
                credentialFingerprint: createHash("sha256")
                  .update("test-managed-key")
                  .digest("hex"),
              },
            ]
          : [],
      );
      expect(JSON.stringify(outcomes)).not.toContain("test-managed-key");
    }
  });
});
