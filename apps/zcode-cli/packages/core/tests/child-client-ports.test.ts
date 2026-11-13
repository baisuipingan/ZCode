import { describe, expect, it } from "vitest";
import {
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import { deriveChildClientPorts } from "../src/runtime/helpers/child-client-ports.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../src/runtime/methods/model-runtime-headers.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("原turn的私有结算反馈", () => {
  it.each(["success", "failure", "cancelled"] as const)(
    "%s只在原finally反馈一次冻结归属",
    async (terminal) => {
      const billingBinding = {
        origin: "https://example.invalid",
        accountRef: "A",
        accountEpoch: 1,
        policyRevision: "scope",
      };
      const expected = structuredClone(billingBinding);
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const outcomes: unknown[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId(`managed-settlement-${terminal}`),
        { workingDirectory: "/workspace" },
        {
          eventStore: createTestSessionEventStore(),
          providerRuntimeHeadersPort: {
            billingBinding,
            refreshBeforeModelRequest: async () => ({ headersApplied: true }),
            reportManagedOutcome(input) {
              outcomes.push(input.outcome);
            },
          },
          modelFactory: createTestModelFactory({
            async generateText(request, observation) {
              expect(observation.invocationContext?.reportManagedOutcome).toBeTypeOf("function");
              started.resolve();
              await finish.promise;
              if (terminal === "failure") throw new Error("synthetic model failure");
              if (terminal === "cancelled")
                throw request.abortSignal?.reason ?? new Error("cancelled");
              return {
                text: "done",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
        },
      );
      try {
        const turn = runtime.executeTurn("test managed settlement");
        await started.promise;
        expect(outcomes).toEqual([]);
        billingBinding.accountRef = "B";
        if (terminal === "cancelled")
          runtime.stopActiveForegroundExecution({ reason: "user_stop" });
        finish.resolve();
        await turn.catch(() => undefined);
        expect(outcomes).toEqual([{ kind: "turn_settled", billingBinding: expected }]);
      } finally {
        finish.resolve();
        await runtime.close();
      }
    },
  );
});

/**
 * docs/zcode-protocol-model-backed-control-requests.md「反向请求的会话路由与终止保证」契约 2。
 *
 * 回归背景（2026-09-09）：dwf actor 与 legacy workflow child 曾把 workspace 级端口原样塞进
 * runtime deps，于是子 runtime 带着自己的 `sess_dwf-…` 去问桌面；桌面找不到 session，
 * response 永不发出，子代理在首个模型请求前挂死。这里钉住派生的三条性质。
 */
describe("deriveChildClientPorts", () => {
  const rootSessionId = createSessionId("root-session");
  const childSessionId = createSessionId("child-session");
  const grandchildSessionId = createSessionId("grandchild-session");

  it("显式普通 API scope 不向父端口的 managed B 借绑定", () => {
    const parentBinding = {
      origin: "https://example.invalid",
      accountRef: "B",
      accountEpoch: 1,
      policyRevision: "scope",
    };
    const child = deriveChildClientPorts(
      {
        providerRuntimeHeadersPort: {
          billingBinding: parentBinding,
          refreshBeforeModelRequest: async () => ({ headersApplied: true }),
        },
      },
      {
        agentId: "ordinary",
        agentType: "workflow",
        childSessionId,
        parentSessionId: rootSessionId,
        billingBinding: undefined,
      },
    );
    expect(child.providerRuntimeHeadersPort?.billingBinding).toBeUndefined();
  });

  it("延迟子任务传入原 A scope 后，不读取父 runtime 此刻的 B", async () => {
    const original = {
      origin: "https://example.invalid",
      accountRef: "A",
      accountEpoch: 1,
      policyRevision: "scope",
    };
    const current = { ...original, accountRef: "B" };
    const runtime = createTestAgentRuntime(
      rootSessionId,
      { workingDirectory: "/workspace" },
      {
        eventStore: createTestSessionEventStore(),
        providerRuntimeHeadersPort: {
          billingBinding: current,
          refreshBeforeModelRequest: async () => ({ headersApplied: true }),
        },
      },
    );
    try {
      const scope = { billingBinding: structuredClone(original) };
      const child = runtime.createChildClientPorts(
        {
          agentId: "delayed",
          agentType: "workflow",
          childSessionId,
        },
        scope,
      );
      scope.billingBinding.accountRef = "mutated";
      expect(child.providerRuntimeHeadersPort?.billingBinding).toEqual(original);
      expect(
        runtime.createChildClientPorts(
          {
            agentId: "ordinary",
            agentType: "workflow",
            childSessionId,
          },
          {},
        ).providerRuntimeHeadersPort?.billingBinding,
      ).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("私有结算反馈逐层路由根会话，保留原billingBinding", () => {
    const received: unknown[] = [];
    const billingBinding = {
      origin: "https://example.invalid",
      accountRef: "A",
      accountEpoch: 1,
      policyRevision: "scope",
    };
    const root = {
      providerRuntimeHeadersPort: {
        refreshBeforeModelRequest: async () => ({ headersApplied: true }),
        reportManagedOutcome: (input: unknown) => {
          received.push(input);
        },
      },
    };
    const child = deriveChildClientPorts(root, {
      agentId: "child",
      agentType: "explore",
      childSessionId,
      parentSessionId: rootSessionId,
      billingBinding,
    });
    const grandchild = deriveChildClientPorts(child, {
      agentId: "grandchild",
      agentType: "explore",
      childSessionId: grandchildSessionId,
      parentSessionId: childSessionId,
      billingBinding,
    });
    const outcome = { kind: "turn_settled" as const, billingBinding };
    grandchild.providerRuntimeHeadersPort?.reportManagedOutcome?.({
      outcome,
      sessionId: grandchildSessionId,
    });
    expect(received).toEqual([{ outcome, sessionId: rootSessionId }]);
  });

  it("子会话 PAT 恢复通过 core 原端口携带作用域和指纹，仍路由到根会话", async () => {
    const received: unknown[] = [];
    const response = {
      headersApplied: true,
      requestAuth: { apiKey: "fresh-pat", accountScope: "a".repeat(64) },
    };
    const ports = deriveChildClientPorts(
      {
        providerRuntimeHeadersPort: {
          refreshBeforeModelRequest: async (input) => {
            received.push(input);
            return response;
          },
        },
      },
      { agentId: "agent", agentType: "explore", childSessionId, parentSessionId: rootSessionId },
    );
    const refresh = createRefreshRuntimeHeadersBeforeModelAttempt(
      { sessionId: childSessionId, ...ports } as never,
      {
        model: { providerId: "account", modelId: "glm" } as never,
        traceContext: { traceId: createTraceId() },
      },
    )!;
    const recovery = {
      attempt: 2,
      expectedAccountScope: "a".repeat(64),
      rejectedProjectTokenFingerprint: "b".repeat(64),
    };
    expect(await refresh(recovery)).toEqual(response);
    expect(received).toEqual([
      expect.objectContaining({
        sessionId: rootSessionId,
        expectedAccountScope: recovery.expectedAccountScope,
        rejectedProjectTokenFingerprint: recovery.rejectedProjectTokenFingerprint,
      }),
    ]);
  });

  function makeRequest(sessionId = grandchildSessionId): PermissionBrokerRequest {
    return {
      requestId: "req-1",
      sessionId,
      turnId: createTurnId(),
      traceId: createTraceId(),
      toolCallId: createToolCallId(),
      toolName: "Bash",
      input: { command: "ls" },
      mode: "build",
      ruleId: "rule-1",
      reason: "test",
      riskLevel: "low",
      requestedAt: new Date(0),
    } as PermissionBrokerRequest;
  }

  function recordingBroker() {
    const seen: PermissionBrokerRequest[] = [];
    return {
      seen,
      port: {
        requestPermission(request: PermissionBrokerRequest): Promise<PermissionBrokerResult> {
          seen.push(request);
          return Promise.resolve({ decision: "allow" } as PermissionBrokerResult);
        },
      },
    };
  }

  const originContext = {
    agentId: "agent-1",
    agentType: "explore",
    childSessionId,
    description: "child agent",
  };

  function headersInput(sessionId: ReturnType<typeof createSessionId>) {
    return {
      modelId: "model-a",
      providerId: "provider-a",
      reason: "model-request" as const,
      sessionId,
      traceContext: { traceId: createTraceId() } as never,
    };
  }

  it("provider runtime headers 请求改写成父会话；嵌套两层收敛到根", async () => {
    const seen: string[] = [];
    const parentPort = {
      shouldRefreshBeforeModelRequest: () => true,
      refreshBeforeModelRequest: async (input: { sessionId: string }) => {
        seen.push(input.sessionId);
        return { headersApplied: true };
      },
    };

    // root → child
    const childPorts = deriveChildClientPorts(
      { providerRuntimeHeadersPort: parentPort },
      { ...originContext, parentSessionId: rootSessionId },
    );
    await childPorts.providerRuntimeHeadersPort!.refreshBeforeModelRequest(
      headersInput(childSessionId),
    );
    expect(seen).toEqual([rootSessionId]);
    expect(
      childPorts.providerRuntimeHeadersPort!.shouldRefreshBeforeModelRequest?.({
        modelId: "model-a",
        providerId: "provider-a",
      }),
    ).toBe(true);

    // child → grandchild：外层（离客户端更近的一层）最后改写，最终值必然是根会话。
    const grandchildPorts = deriveChildClientPorts(
      { providerRuntimeHeadersPort: childPorts.providerRuntimeHeadersPort! },
      {
        agentId: "agent-2",
        agentType: "general-purpose",
        childSessionId: grandchildSessionId,
        description: "grandchild agent",
        parentSessionId: childSessionId,
      },
    );
    await grandchildPorts.providerRuntimeHeadersPort!.refreshBeforeModelRequest(
      headersInput(grandchildSessionId),
    );
    expect(seen).toEqual([rootSessionId, rootSessionId]);
  });

  it("子代理捕获原运行扣费归属，不跟随父端口随后换号", () => {
    const billingBinding = {
      origin: "https://account.example",
      accountRef: "user:A",
      accountEpoch: 1,
      policyRevision: "A",
    };
    const parentPort = {
      billingBinding,
      refreshBeforeModelRequest: async () => ({ headersApplied: true }),
    };
    const child = deriveChildClientPorts(
      { providerRuntimeHeadersPort: parentPort },
      { ...originContext, parentSessionId: rootSessionId, billingBinding },
    );
    billingBinding.accountRef = "user:B";
    expect(child.providerRuntimeHeadersPort?.billingBinding?.accountRef).toBe("user:A");
  });

  it("父没有端口时不合成空实现（键缺席，不是 undefined 值）", () => {
    const derived = deriveChildClientPorts(
      {},
      { ...originContext, parentSessionId: rootSessionId },
    );

    expect("providerRuntimeHeadersPort" in derived).toBe(false);
    expect("permissionBroker" in derived).toBe(false);
  });

  it("permission 请求改写成父会话，并带上子代理 origin", async () => {
    const parent = recordingBroker();

    const derived = deriveChildClientPorts(
      { permissionBroker: parent.port },
      { ...originContext, parentSessionId: rootSessionId },
    );
    await derived.permissionBroker!.requestPermission(makeRequest(childSessionId));

    expect(parent.seen).toHaveLength(1);
    expect(parent.seen[0]!.sessionId).toBe(rootSessionId);
    expect(parent.seen[0]!.origin).toMatchObject({
      kind: "subagent",
      agentId: "agent-1",
      childSessionId,
      parentSessionId: rootSessionId,
    });
  });

  it("嵌套两层：sessionId 收敛到根，origin 保留最内层子代理", async () => {
    const root = recordingBroker();

    // root → child
    const childPorts = deriveChildClientPorts(
      { permissionBroker: root.port },
      { ...originContext, parentSessionId: rootSessionId },
    );
    // child → grandchild（父会话是 child 自己）
    const grandchildPorts = deriveChildClientPorts(
      { permissionBroker: childPorts.permissionBroker! },
      {
        agentId: "agent-2",
        agentType: "general-purpose",
        childSessionId: grandchildSessionId,
        description: "grandchild agent",
        parentSessionId: childSessionId,
      },
    );

    await grandchildPorts.permissionBroker!.requestPermission(makeRequest());

    expect(root.seen).toHaveLength(1);
    // 外层（离客户端更近的一层）最后改写 sessionId，所以最终值是根会话——
    // 客户端只认识它。
    expect(root.seen[0]!.sessionId).toBe(rootSessionId);
    // origin 反过来保留最内层：归属是真正发起请求的孙子代理，不是中间层。
    expect(root.seen[0]!.origin).toMatchObject({
      agentId: "agent-2",
      childSessionId: grandchildSessionId,
    });
  });
});
