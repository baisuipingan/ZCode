import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
  completeNewModelSelection,
  EnumOptionSpecConfig,
  ModelConfig,
  serializeRegistryModelConfig,
  ModelSelectionFacade,
} from "@zcode/provider";
import { completeEnumOptionSpecDataSchema } from "@zcode/shared/model-config";
import { createModelCatalogPort } from "../src/app/model-catalog-port.js";
import {
  completeAuxiliaryRegistryModelSelection,
  listRegistryBackedModels,
} from "../src/app/provider-registry-selection.js";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import {
  zcodeProtocolMethods,
  managedProviderPolicySchema,
  managedModelConfigFingerprint,
  sameManagedBillingBinding,
  type ManagedProviderAccess,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
} from "@zcode/shared";
import {
  startProcessProviderRegistryRuntime,
  parseProcessAccountProviderConfigSnapshot,
} from "../src/app/process-provider-registry-runtime.js";
import {
  runWithModelInvocationContext,
  type ModelStreamEvent,
  type SessionStorePort,
} from "@zcode/contracts";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { ApiProviderModelRuntime } from "../src/app/provider-registry-model-runtime.js";
import type { V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "account-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const started = await startProcessProviderRegistryRuntime({
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(directory, "personal.json"),
  });
  cleanups.unshift(async () => started.dispose());
  return started;
}

function readyManagedPolicy(accountRef = "user:1", revision = "policy-1") {
  const binding = {
    origin: "https://account.example",
    accountRef,
    accountEpoch: 1,
    policyRevision: revision,
  };
  const policy = managedProviderPolicySchema.parse({
    state: "ready",
    revision,
    billingBinding: binding,
    providerId: "milorouter-managed",
    credentialRef: "milorouter:workbench",
    baseUrl: "https://account.example/v1",
    defaultSelection: {
      providerId: "milorouter-managed",
      modelId: "agent-model",
      options: { reasoningLevel: "low" },
    },
    models: [
      {
        modelId: "agent-model",
        modelConfig: {
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
            supportsJsonSchemaOutput: true,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          },
          optionSpecs: {
            reasoningLevel: {
              values: ["low", "high"],
              map: '{"reasoning":{"effort":reasoningLevel}}',
            },
            maxOutputTokens: { max: 8192, map: '{"max_output_tokens":maxOutputTokens}' },
          },
        },
      },
    ],
  });
  if (policy.state !== "ready") throw new Error("invalid ready fixture");
  return policy;
}

describe("托管 Worker 账号交付", () => {
  it("MR02 真实 HTTP SSE 在同账号目录/组/凭据/网关变更时连续完成，旧作用域下一 attempt 不获授权", async () => {
    const httpRequests: string[] = [];
    const requestedReasoning: string[] = [];
    let finishResponse: (() => void) | undefined;
    const httpServer = createServer((request, response) => {
      httpRequests.push(request.url ?? "");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requestedReasoning.push(JSON.parse(body).reasoning.effort);
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const write = (frame: Record<string, unknown>) =>
        response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      write({
        type: "response.created",
        response: { id: "response", created_at: 1, model: "agent-model" },
      });
      write({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "message" },
      });
      write({
        type: "response.output_text.delta",
        item_id: "message",
        output_index: 0,
        content_index: 0,
        delta: "first",
      });
      const finish = () => {
        write({
          type: "response.output_text.delta",
          item_id: "message",
          output_index: 0,
          content_index: 0,
          delta: "last",
        });
        write({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "message",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "firstlast", annotations: [] }],
          },
        });
        write({
          type: "response.completed",
          response: {
            id: "response",
            status: "completed",
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        });
        response.end();
      };
      if (httpRequests.length === 1) finishResponse = finish;
      else finish();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing SSE fixture port");
    const origin = `http://127.0.0.1:${address.port}`;
    const started = await startRuntime();
    const policy = readyManagedPolicy();
    policy.baseUrl = `${origin}/v1`;
    policy.billingBinding.origin = origin;
    policy.models[0]!.modelConfig.optionSpecs.reasoningLevel!.defaultLevel = "low";
    let latestPolicy = policy;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("configuration must not create a session");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
      readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
    });
    const apply = async (next: typeof policy, revision: string) => {
      const result = await server.handleMessage({
        id: revision,
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          revision,
          basedOnZCodeBuiltinRevision: "managed",
          providers: {},
          states: {},
          managedPolicy: next,
        },
      });
      expect(result).toMatchObject({ result: { managedReady: true } });
      latestPolicy = next;
    };
    await apply(policy, "initial");
    const active = new AbortController();
    cleanups.unshift(async () => active.abort());
    const close = vi.fn();
    const app = createFakeApp(undefined, { close });
    app.runtime.beginShutdown = vi.fn();
    app.runtime.stopActiveForegroundExecution = vi.fn(() => ({ kind: "idle" }));
    const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
    context.sessions.set(app.sessionId, {
      app,
      activeAbortController: active,
      workspace: { workspaceKey: "/work", workspacePath: "/work" },
    } as unknown as ZCodeProtocolSessionRecord);
    const runtime = new ApiProviderModelRuntime({
      registry: started.runtime.registryService,
      modelAdapter: new AiSdkModelAdapter({
        env: {},
        retry: { maxAttempts: 1 },
        requestSecurityState: {
          createExecution: () => ({
            protectTransport: ({ transport }) => transport,
            take: () => [],
          }),
        },
      }),
    });
    runtime.start();
    cleanups.unshift(async () => runtime.dispose());
    const model = runtime.modelFactory({
      selection: policy.defaultSelection!,
      requestDependencies: { billingBinding: policy.billingBinding },
    });
    const refresh = vi.fn(
      async (input: { managedAccess?: ManagedProviderAccess; modelConfigRevision?: string }) => {
        if (
          !sameManagedBillingBinding(
            input.managedAccess?.billingBinding,
            latestPolicy.billingBinding,
          ) ||
          input.managedAccess?.credentialRef !== latestPolicy.credentialRef
        ) {
          throw new Error("managed_billing_binding_changed");
        }
        expect(input.modelConfigRevision).toBe(
          managedModelConfigFingerprint(latestPolicy.models[0]!.modelConfig),
        );
        return { headersApplied: true, requestAuth: { apiKey: "synthetic-sse-only" } };
      },
    );
    const firstText = Promise.withResolvers<void>();
    const events: ModelStreamEvent[] = [];
    const consume = (targetEvents = events) =>
      runWithModelInvocationContext({ refreshRuntimeHeadersBeforeAttempt: refresh }, async () => {
        for await (const event of model.streamText({
          messages: [{ role: "user", content: "hello" }],
          options: { maxOutputTokens: 64 },
          abortSignal: active.signal,
        })) {
          targetEvents.push(event);
          if (event.type === "text_delta") firstText.resolve();
        }
      });
    const streaming = consume();
    void streaming.catch(firstText.reject);
    await firstText.promise;
    const next = structuredClone(policy);
    next.revision = "catalog-update";
    next.models[0]!.displayName = "Friendly model";
    next.models[0]!.modelConfig.optionSpecs.reasoningLevel!.defaultLevel = "high";
    next.defaultSelection!.options!.reasoningLevel = "high";
    expect(managedModelConfigFingerprint(next.models[0]!.modelConfig)).toBe(
      managedModelConfigFingerprint(policy.models[0]!.modelConfig),
    );
    await apply(next, "recommendation-update");
    const existingSelectionEvents: ModelStreamEvent[] = [];
    await consume(existingSelectionEvents);
    expect(existingSelectionEvents.some((event) => event.type === "finish")).toBe(true);
    expect(requestedReasoning).toEqual(["low", "low"]);
    const routing = structuredClone(next);
    routing.revision = "routing-update";
    routing.billingBinding.policyRevision = "new-group-scope";
    routing.credentialRef = "new-credential-reference";
    routing.baseUrl = "https://new-gateway.example/v1";
    routing.providerId = "new-managed-provider";
    routing.defaultSelection!.providerId = routing.providerId;
    await apply(routing, "routing-update");
    expect(active.signal.aborted).toBe(false);
    expect(app.runtime.beginShutdown).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    finishResponse!();
    await streaming;
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("firstlast");
    expect(events.some((event) => event.type === "finish")).toBe(true);
    await expect(consume()).rejects.toThrow("managed_billing_binding_changed");
    expect(httpRequests).toEqual(["/v1/responses", "/v1/responses"]);
    expect(refresh).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("MR02 同授权目录新增/改名/默认/删除/能力变化均保留运行，空目录与无默认不回落", async () => {
    const started = await startRuntime();
    const policy = readyManagedPolicy();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("config must not create a session");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
      readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
    });
    const apply = (managedPolicy: unknown, revision: string) =>
      server.handleMessage({
        id: revision,
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          revision,
          basedOnZCodeBuiltinRevision: "managed",
          providers: {},
          states: {},
          managedPolicy,
        },
      });
    await apply(policy, "initial");
    const active = new AbortController();
    const close = vi.fn();
    const app = createFakeApp(undefined, { close });
    app.runtime.beginShutdown = vi.fn();
    app.runtime.stopActiveForegroundExecution = vi.fn(() => ({ kind: "idle" }));
    const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
    context.sessions.set(app.sessionId, {
      app,
      activeAbortController: active,
      workspace: { workspaceKey: "/work", workspacePath: "/work" },
    } as unknown as ZCodeProtocolSessionRecord);
    const originalFingerprint = managedModelConfigFingerprint(policy.models[0]!.modelConfig);
    const updated = structuredClone(policy);
    updated.revision = "catalog-revision-only";
    updated.models[0]!.displayName = "Friendly model";
    const second = structuredClone(updated.models[0]!);
    second.modelId = "second";
    updated.models.push(second);
    updated.defaultSelection = { ...policy.defaultSelection!, modelId: "second" };
    expect(await apply(updated, "expanded")).toMatchObject({ result: { managedReady: true } });
    expect(managedModelConfigFingerprint(updated.models[0]!.modelConfig)).toBe(originalFingerprint);
    const registry = started.runtime.registryService;
    expect(listRegistryBackedModels(registry)[0]!.label).toBe("Friendly model");
    expect(
      new ModelSelectionFacade(registry).getView(updated.defaultSelection).providers[0]!.models[0]!
        .displayName,
    ).toBe("Friendly model");
    updated.models = [second];
    expect(await apply(updated, "removed")).toMatchObject({ result: { managedReady: true } });
    expect(registry.validateSelection(policy.defaultSelection!)).toMatchObject({
      code: "model-not-found",
    });
    second.modelConfig.properties.contextWindow += 1000;
    expect(managedModelConfigFingerprint(second.modelConfig)).not.toBe(originalFingerprint);
    expect(await apply(updated, "capability")).toMatchObject({ result: { managedReady: true } });
    updated.defaultSelection = null;
    expect(await apply(updated, "default-unavailable")).toMatchObject({
      result: { managedReady: true },
    });
    expect(new ModelSelectionFacade(registry).getView(null)).not.toHaveProperty(
      "preferredSelection",
    );
    updated.models = [];
    expect(await apply(updated, "all-models-unavailable")).toMatchObject({
      result: { managedReady: true, appliedRevision: "all-models-unavailable" },
    });
    expect(registry.getView().providers).toEqual([]);
    expect(started.getConfiguredDefaultModelSelection()).toBeNull();
    expect(app.runtime.beginShutdown).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(active.signal.aborted).toBe(false);
    expect(context.sessions.has(app.sessionId)).toBe(true);
  });

  it("MR06 队列提升的控制面同步失败先于reserve/stop/remove，原队列输入保留", async () => {
    const started = await startRuntime();
    const policy = readyManagedPolicy();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("admission must not create a session");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
      readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
    });
    await server.handleMessage({
      id: "ready",
      method: zcodeProtocolMethods.providerUpdateAccountConfig,
      params: {
        revision: "ready",
        basedOnZCodeBuiltinRevision: "managed",
        providers: {},
        states: {},
        managedPolicy: policy,
      },
    });
    const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
    const reserveQueueItem = vi.fn();
    const removeQueueItem = vi.fn();
    const app = createFakeApp(undefined, { reserveQueueItem, removeQueueItem });
    app.runtime.stopActiveForegroundExecution = vi.fn(() => ({ kind: "idle" }));
    context.sessions.set(app.sessionId, {
      app,
      traceContext: { traceId: "mr06" },
      workspace: { workspaceKey: "/work", workspacePath: "/work" },
    } as unknown as ZCodeProtocolSessionRecord);
    const request = vi
      .spyOn(context, "requestClient")
      .mockRejectedValue(new Error("control-plane-offline"));
    const host = (context.v4Gateway! as unknown as { host: V4GatewayHost }).host;
    await expect(
      host.executeCommand(
        {
          type: "sendQueuedNow",
          commandId: "promote",
          sessionId: app.sessionId,
          clientId: "client",
          issuedAt: 1,
          payload: { queueItemId: "retained-item" },
        },
        { admissionSeq: 1, admittedAt: 1, queueItemId: "promotion" },
      ),
    ).rejects.toThrow("control-plane-offline");
    expect(request.mock.calls[0]![1]).toMatchObject({
      phase: "admission",
      managedAccess: {
        billingBinding: policy.billingBinding,
      },
    });
    expect(reserveQueueItem).not.toHaveBeenCalled();
    expect(removeQueueItem).not.toHaveBeenCalled();
    expect(app.runtime.stopActiveForegroundExecution).not.toHaveBeenCalled();
  });

  it.each([
    "new-group",
    "existing-binding",
    "retry-binding",
    "account",
    "epoch",
    "origin",
  ] as const)(
    "MR06 freshness 恰逢 %s：新输入只在同账号下首次采用最新 scope，历史绑定不迁移",
    async (change) => {
      const started = await startRuntime();
      const policy = readyManagedPolicy();
      const saveSessionInput = vi.fn(async () => {});
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp() {
          throw new Error("admission must not create a session");
        },
        syncAccountProviderConfig: started.syncAccountProviderConfig,
        readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
        sessionStore: {
          getSession: async () => ({ directory: "/work" }),
          saveSessionInput,
        } as unknown as SessionStorePort,
      });
      const apply = (managedPolicy: unknown, revision: string) =>
        server.handleMessage({
          id: revision,
          method: zcodeProtocolMethods.providerUpdateAccountConfig,
          params: {
            revision,
            basedOnZCodeBuiltinRevision: "managed",
            providers: {},
            states: {},
            managedPolicy,
          },
        });
      await apply(policy, "initial");
      const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
      const gateway = context.v4Gateway!;
      const host = (gateway as unknown as { host: V4GatewayHost }).host;
      const refreshed = structuredClone(policy);
      refreshed.revision = "new-directory";
      refreshed.billingBinding.policyRevision = "new-group-scope";
      refreshed.credentialRef = "new-key-reference";
      if (change === "account") refreshed.billingBinding.accountRef = "user:B";
      if (change === "epoch") refreshed.billingBinding.accountEpoch += 1;
      if (change === "origin") refreshed.billingBinding.origin = "https://other-account.example";
      const request = vi
        .spyOn(context, "requestClient")
        .mockImplementation(async (_method, params) => {
          expect(params).toMatchObject({
            phase: "admission",
            managedAccess: { billingBinding: policy.billingBinding },
          });
          expect(saveSessionInput).not.toHaveBeenCalled();
          expect(await apply(refreshed, "refreshed")).toMatchObject({
            result: { managedReady: true },
          });
          return { headersApplied: true, requestAuth: {} };
        });
      const admission = {
        admissionSeq: 1,
        admittedAt: 1,
        queueItemId: "input",
        ...(change === "existing-binding"
          ? { billingBinding: structuredClone(policy.billingBinding) }
          : {}),
      };
      if (change === "retry-binding") {
        vi.spyOn(gateway, "resolveRowActionTarget").mockReturnValue({
          ok: true,
          editTarget: {
            intent: {
              kind: "sendText",
              text: "original",
              sourceCommandId: "original",
              billingBinding: policy.billingBinding,
            },
          },
        } as unknown as ReturnType<typeof gateway.resolveRowActionTarget>);
      }
      const result = host.admitCommandInput!(
        {
          type: change === "retry-binding" ? "retryTurn" : "sendText",
          commandId: "new-command",
          sessionId: "session",
          clientId: "client",
          issuedAt: 1,
          payload:
            change === "retry-binding"
              ? { target: { rowId: 1, entityId: "message" } }
              : { text: "new work" },
        },
        admission,
      );
      if (change === "new-group") {
        await expect(result).resolves.toMatchObject({ billingBinding: refreshed.billingBinding });
        expect(admission).toHaveProperty("billingBinding", refreshed.billingBinding);
        expect(saveSessionInput).toHaveBeenCalledOnce();
        expect(saveSessionInput.mock.calls[0]).toMatchObject([
          {
            payload: {
              conversationInputIntent: { billingBinding: refreshed.billingBinding },
            },
          },
        ]);
      } else {
        await expect(result).rejects.toMatchObject({
          reasonCode: "managed_billing_binding_changed",
        });
        expect(saveSessionInput).not.toHaveBeenCalled();
        if (change === "existing-binding")
          expect(admission.billingBinding).toEqual(policy.billingBinding);
      }
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("品牌策略原子应用并确认，Personal/官方失配不得回退，blocked 清空执行集合", async () => {
    const started = await startRuntime();
    const policy = readyManagedPolicy();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("configuration does not create a session");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
      readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
    });
    const apply = (managedPolicy: unknown, revision: string) =>
      server.handleMessage({
        id: revision,
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          revision,
          basedOnZCodeBuiltinRevision: "deliberately-unmatched-official-revision",
          providers: {},
          states: {},
          managedPolicy,
        },
      });
    expect(await apply(policy, "managed-ready")).toMatchObject({
      result: {
        receivedRevision: "managed-ready",
        appliedRevision: "managed-ready",
        managedReady: true,
      },
    });
    expect(
      started.runtime.registryService
        .getSnapshot()
        ?.registry.providers.map((provider) => provider.providerId),
    ).toEqual(["milorouter-managed"]);
    expect(started.getConfiguredDefaultModelSelection()?.options?.reasoningLevel).toBe("low");
    const serialized = JSON.stringify(
      started.runtime.registryService.getSnapshot()?.resolution.registryProviders[0]?.config,
    );
    expect(serialized).toContain("brand-managed");
    expect(serialized).not.toContain("apiKey");
    expect(
      await apply({ state: "blocked", revision: "blocked-2" }, "managed-blocked"),
    ).toMatchObject({
      result: {
        appliedRevision: "managed-blocked",
        managedReady: false,
      },
    });
    expect(started.runtime.registryService.getSnapshot()?.registry.providers).toEqual([]);
    expect(started.getConfiguredDefaultModelSelection()).toBeUndefined();
  });

  it.each(["blocked", "account", "epoch", "origin"] as const)(
    "%s 切换沿原关闭链停止前台及 sidecar，相同策略重交不取消",
    async (change) => {
      const started = await startRuntime();
      const policy = readyManagedPolicy();
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp() {
          throw new Error("configuration must not create a session");
        },
        syncAccountProviderConfig: started.syncAccountProviderConfig,
        readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
      });
      const apply = (managedPolicy: unknown, revision: string) =>
        server.handleMessage({
          id: revision,
          method: zcodeProtocolMethods.providerUpdateAccountConfig,
          params: {
            revision,
            basedOnZCodeBuiltinRevision: "managed",
            providers: {},
            states: {},
            managedPolicy,
          },
        });
      expect(await apply(policy, "ready")).toHaveProperty("result");
      const active = new AbortController();
      const sidecar = new AbortController();
      const close = vi.fn(async () => expect(sidecar.signal.aborted).toBe(true));
      const removeQueueItem = vi.fn(async () => true);
      const app = createFakeApp(undefined, { close, removeQueueItem });
      app.runtime.beginShutdown = vi.fn(() => sidecar.abort());
      app.runtime.stopActiveForegroundExecution = vi.fn(() => ({ kind: "idle" }));
      const eventStore = createInMemorySessionEventStore();
      const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
      context.sessions.set(app.sessionId, {
        app,
        eventStore,
        activeAbortController: active,
        workspace: { workspaceKey: "/work", workspacePath: "/work" },
        persistence: "immediate",
        taskType: "task",
        unsubscribe() {},
      } as unknown as ZCodeProtocolSessionRecord);
      expect(await apply(policy, "same-policy")).toHaveProperty("result");
      expect(app.runtime.beginShutdown).not.toHaveBeenCalled();
      const next =
        change === "blocked"
          ? { state: "blocked", revision: "blocked" }
          : readyManagedPolicy(change === "account" ? "user:B" : "user:1", "policy-2");
      if (next.state === "ready") {
        if (change === "epoch") next.billingBinding.accountEpoch += 1;
        if (change === "origin") next.billingBinding.origin = "https://other-account.example";
      }
      expect(await apply(next, "changed-policy")).toHaveProperty("result");
      expect(active.signal.aborted).toBe(true);
      expect(sidecar.signal.aborted).toBe(true);
      expect(app.runtime.stopActiveForegroundExecution).toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(removeQueueItem).not.toHaveBeenCalled();
      expect(context.sessions.has(app.sessionId)).toBe(false);
    },
  );

  it.each(["retryTurn", "editUserQuery"] as const)(
    "%s 不给旧或缺失绑定写入新扣费授权",
    async (type) => {
      const started = await startRuntime();
      const policy = readyManagedPolicy();
      const saveSessionInput = vi.fn(async () => {});
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp() {
          throw new Error("admission must not create a session");
        },
        syncAccountProviderConfig: started.syncAccountProviderConfig,
        readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
        sessionStore: {
          getSession: async () => ({ directory: "/work" }),
          saveSessionInput,
        } as unknown as SessionStorePort,
      });
      await server.handleMessage({
        id: "ready",
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          revision: "ready",
          basedOnZCodeBuiltinRevision: "managed",
          providers: {},
          states: {},
          managedPolicy: policy,
        },
      });
      const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
      const gateway = context.v4Gateway!;
      vi.spyOn(context, "requestClient").mockResolvedValue({
        headersApplied: true,
        requestAuth: {},
      });
      const host = (gateway as unknown as { host: V4GatewayHost }).host;
      for (const originalBinding of [
        undefined,
        { ...policy.billingBinding, accountRef: "user:A" },
      ]) {
        vi.spyOn(gateway, "resolveRowActionTarget").mockReturnValue({
          ok: true,
          editTarget: {
            intent: {
              kind: "sendText",
              text: "original",
              sourceCommandId: "original-command",
              billingBinding: originalBinding,
            },
          },
        } as unknown as ReturnType<typeof gateway.resolveRowActionTarget>);
        await expect(
          host.admitCommandInput!(
            {
              type,
              commandId: "retry",
              sessionId: "session",
              clientId: "client",
              issuedAt: 1,
              payload: {
                target: { rowId: 1, entityId: "message" },
                ...(type === "editUserQuery" ? { newText: "edited" } : {}),
              },
            },
            { admissionSeq: 1, admittedAt: 1, queueItemId: "queue" },
          ),
        ).rejects.toMatchObject({ reasonCode: "managed_billing_binding_changed" });
      }
      expect(saveSessionInput).not.toHaveBeenCalled();
    },
  );

  it("托管策略和反向鉴权严格拒绝秘密字段与混用官方账号", () => {
    expect(
      managedProviderPolicySchema.safeParse({
        state: "blocked",
        revision: "1",
        apiKey: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse({
        requestId: "request",
        sessionId: "session",
        workspace: { workspaceKey: "/work", workspacePath: "/work" },
        providerId: "managed",
        modelSelection: { providerId: "managed", modelId: "model" },
        reason: "model-request",
        managedAccess: {
          credentialRef: "workbench",
          billingBinding: {
            origin: "https://account.example",
            accountRef: "user:1",
            accountEpoch: 1,
            policyRevision: "1",
          },
        },
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "start-plan",
          entitled: true,
        },
      }).success,
    ).toBe(false);
  });
  it("Account B 先到时接收 B、仍使用 A；配套配置到后才整体应用 B", async () => {
    const started = await startRuntime();
    const registry = started.runtime.registryService;
    const previous = registry.getSnapshot();
    const next = createAccountProviderConfigSnapshot("builtin-B", ProviderConfigMap.empty(), {});
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("账号交付不得创建会话");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
    });
    expect(
      await server.handleMessage({
        id: 1,
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          ...next,
          providers: Object.fromEntries(
            [...next.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
          ),
        },
      }),
    ).toMatchObject({
      result: { receivedRevision: next.revision, providerCount: 0, status: "received" },
    });
    expect((await started.accountSource.read()).revision).toBe(next.revision);
    expect(registry.getSnapshot()).toBe(previous);

    const config = await started.runtime.configService.read();
    vi.spyOn(started.runtime.configService, "read").mockResolvedValue({
      ...config,
      revision: "config-B",
      zcodeBuiltinRevision: "builtin-B",
    });
    await registry.refresh("配套配置到达");
    expect(registry.getSnapshot()?.account.revision).toBe(next.revision);
    expect(registry.getSnapshot()?.config.zcodeBuiltinRevision).toBe("builtin-B");
  });

  it("刷新失败后同一份快照重交仍刷新，不能因 Source 已收过而跳过", async () => {
    const started = await startRuntime();
    const next = createAccountProviderConfigSnapshot(
      started.snapshot.config.zcodeBuiltinRevision,
      ProviderConfigMap.empty(),
      {},
    );
    const refresh = vi
      .spyOn(started.runtime.registryService, "refresh")
      .mockRejectedValueOnce(new Error("refresh failed"));
    await expect(started.syncAccountProviderConfig(next)).rejects.toThrow("refresh failed");
    await expect(started.syncAccountProviderConfig(next)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(started.runtime.registryService.getSnapshot()?.account.revision).toBe(next.revision);
  });

  it("普通账号有权益却缺 current 时拒绝交付，不能宽松放行", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "incomplete",
        basedOnZCodeBuiltinRevision: "builtin-A",
        providers: {
          "account:bigmodel-individual-coding-plan": {
            access: { type: "zhipu-account", entitled: true },
          },
        },
        states: {},
      }),
    ).toThrow("current");
  });

  it.each([
    { providerId: "account:bigmodel-individual-coding-plan", entitled: false },
    { providerId: "account:bigmodel-offpeak-idle-plan", entitled: true },
  ])("初始 fail-closed 和闲时不被强加 current：$providerId", ({ providerId, entitled }) => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "allowed",
        basedOnZCodeBuiltinRevision: "builtin-A",
        states: {},
        providers: { [providerId]: { access: { type: "zhipu-account", entitled } } },
      }),
    ).not.toThrow();
  });
});

it("MM04 多模型真实Registry/RPC全量应用，删除更新不残留，缺项ACK不就绪", async () => {
  const started = await startRuntime();
  const policy = readyManagedPolicy();
  const second = structuredClone(policy.models[0]!);
  second.modelId = "agent-second";
  second.modelConfig.properties.contextWindow = 256000;
  second.modelConfig.optionSpecs.maxOutputTokens = {
    max: 16000,
    map: '{"max_output_tokens":maxOutputTokens}',
  };
  policy.models.push(second);
  policy.defaultSelection.modelId = second.modelId;
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp() {
      throw new Error("configuration does not create a session");
    },
    syncAccountProviderConfig: started.syncAccountProviderConfig,
    readProviderRegistrySnapshot: started.readProviderRegistrySnapshot,
  });
  const apply = (managedPolicy: unknown, revision: string) =>
    server.handleMessage({
      id: revision,
      method: zcodeProtocolMethods.providerUpdateAccountConfig,
      params: {
        revision,
        basedOnZCodeBuiltinRevision: "managed",
        providers: {},
        states: {},
        managedPolicy,
      },
    });
  expect(await apply(policy, "multi-1")).toMatchObject({
    result: { managedReady: true, appliedRevision: "multi-1" },
  });
  const registry = started.readProviderRegistrySnapshot()!.registry;
  expect(registry.providers[0]!.models.map((model) => model.modelId)).toEqual([
    "agent-model",
    "agent-second",
  ]);
  expect(registry.providers[0]!.models[0]!.config.optionSpecs.maxOutputTokens.max).toBe(8192);
  expect(registry.providers[0]!.models[1]!.config.optionSpecs.maxOutputTokens.max).toBe(16000);
  expect(started.getConfiguredDefaultModelSelection()?.modelId).toBe("agent-second");
  const missing = new ZCodeProtocolAgentServer({
    createZCodeApp() {
      throw new Error("configuration does not create a session");
    },
    syncAccountProviderConfig: started.syncAccountProviderConfig,
    readProviderRegistrySnapshot() {
      const snapshot = started.readProviderRegistrySnapshot();
      if (!snapshot) return snapshot;
      return {
        ...snapshot,
        registry: {
          ...snapshot.registry,
          providers: snapshot.registry.providers.map((provider) => ({
            ...provider,
            models: provider.models.filter((model) => model.modelId === "agent-second"),
          })),
        },
      };
    },
  });
  expect(
    await missing.handleMessage({
      id: "missing",
      method: zcodeProtocolMethods.providerUpdateAccountConfig,
      params: {
        revision: "missing",
        basedOnZCodeBuiltinRevision: "managed",
        providers: {},
        states: {},
        managedPolicy: policy,
      },
    }),
  ).toMatchObject({ result: { managedReady: false } });
  expect(
    await apply(
      { ...policy, defaultSelection: { ...policy.defaultSelection, modelId: "absent" } },
      "bad-default",
    ),
  ).toHaveProperty("error");
  const reduced = { ...policy, revision: "policy-2", models: [second] };
  expect(await apply(reduced, "multi-2")).toMatchObject({ result: { managedReady: true } });
  expect(
    started
      .readProviderRegistrySnapshot()!
      .registry.providers[0]!.models.map((model) => model.modelId),
  ).toEqual(["agent-second"]);
});

it("MM05 非全局默认模型保留显式推理默认，完整配置往返不丢失且不重排档位", async () => {
  const started = await startRuntime();
  const policy = readyManagedPolicy();
  const second = structuredClone(policy.models[0]!);
  second.modelId = "agent-second";
  second.modelConfig.optionSpecs.reasoningLevel.defaultLevel = "low";
  policy.models.push(second);
  await started.syncAccountProviderConfig(
    parseProcessAccountProviderConfigSnapshot({
      revision: "explicit-model-default",
      basedOnZCodeBuiltinRevision: "managed",
      providers: {},
      managedPolicy: policy,
    }),
  );
  const registry = started.runtime.registryService;
  const model = registry.getModel(policy.providerId, second.modelId)!;
  expect(model.config.optionSpecs.reasoningLevel.defaultLevel).toBe("low");
  const serialized = JSON.parse(JSON.stringify(serializeRegistryModelConfig(model.config)));
  expect(ModelConfig.fromData(serialized).toJSON().optionSpecs?.reasoningLevel).toMatchObject({
    values: ["low", "high"],
    defaultLevel: "low",
  });
  expect(
    completeNewModelSelection(registry.getView(), {
      providerId: policy.providerId,
      modelId: second.modelId,
    })?.options?.reasoningLevel,
  ).toBe("low");
  expect(
    listRegistryBackedModels(registry).find((item) => item.ref.modelId === second.modelId)
      ?.reasoning?.defaultLevel,
  ).toBe("low");
  const catalog = createModelCatalogPort({
    registry,
    currentSelection: () => policy.defaultSelection,
  });
  expect(catalog.listModels().find((item) => item.modelId === second.modelId)).toMatchObject({
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low",
    current: false,
  });
  expect(started.getConfiguredDefaultModelSelection()?.modelId).toBe("agent-model");
  // 旧配置没有显式元数据时保留原最高档；辅助调用仍使用最低档，不被主模型默认改写。
  expect(
    completeNewModelSelection(registry.getView(), {
      providerId: policy.providerId,
      modelId: "agent-model",
    })?.options?.reasoningLevel,
  ).toBe("high");
  const higherDefault = new EnumOptionSpecConfig(
    second.modelConfig.optionSpecs.reasoningLevel,
  ).overlay(new EnumOptionSpecConfig({ defaultLevel: "high" }));
  const full = ModelConfig.fromData(second.modelConfig).overlay(
    ModelConfig.fromData({ optionSpecs: { reasoningLevel: higherDefault.toJSON() } }),
  );
  expect(full.toJSON().optionSpecs?.reasoningLevel).toMatchObject({
    values: ["low", "high"],
    defaultLevel: "high",
  });
  second.modelConfig.optionSpecs.reasoningLevel.defaultLevel = "high";
  await started.syncAccountProviderConfig(
    parseProcessAccountProviderConfigSnapshot({
      revision: "higher-model-default",
      basedOnZCodeBuiltinRevision: "managed",
      providers: {},
      managedPolicy: policy,
    }),
  );
  expect(
    catalog.listModels().find((item) => item.modelId === second.modelId)?.defaultReasoningLevel,
  ).toBe("high");
  expect(
    completeAuxiliaryRegistryModelSelection(registry, {
      providerId: policy.providerId,
      modelId: second.modelId,
    }).options?.reasoningLevel,
  ).toBe("low");
  expect(
    completeEnumOptionSpecDataSchema.safeParse({
      ...second.modelConfig.optionSpecs.reasoningLevel,
      defaultLevel: "medium",
    }).success,
  ).toBe(false);
  expect(
    completeEnumOptionSpecDataSchema.safeParse(second.modelConfig.optionSpecs.reasoningLevel)
      .success,
  ).toBe(true);
});
