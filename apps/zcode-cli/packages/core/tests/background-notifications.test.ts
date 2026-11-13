// 批量轮的 originMeta 合成（docs/dynamic-workflow/transcript-and-notifications.md「The pipeline and cold restore」）。
//
// 单条通知：originMeta 整体透传，manifest 载荷（workflowNotification）免费搭车。
// 批量轮（多条通知合一轮、标题合成 `a · b · +N`）：**刻意丢弃** workflowNotification——
// 「一轮 ↔ 一张 manifest」的对应在批量下不成立，谎报第一条的载荷比整轮退回裸标题行更坏。
// 这个纪律用测试钉死，防止后续「顺手把载荷也合成过来」的回归。
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import { resolveBackgroundTaskNotificationOriginMeta } from "../src/runtime/methods/background-notifications.js";
import {
  createRuntimeCommandId,
  type TaskNotificationRuntimeCommand,
} from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ManagedBillingBinding } from "@zcode/shared";
import { sameManagedBillingBinding } from "@zcode/shared";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

function makeCommand(originMeta?: BackgroundResultOriginMeta): TaskNotificationRuntimeCommand {
  return {
    branchGeneration: 0,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    text: "notification body",
    traceContext: createRootTraceContext({ sessionId: createSessionId("bg-notif-test") }),
    ...(originMeta ? { originMeta } : {}),
  };
}

const workflowOriginMeta: BackgroundResultOriginMeta = {
  backgroundSource: "workflow",
  title: "nightly audit",
  workId: "dwfrun-1",
  workflowNotification: {
    kind: "terminal",
    status: "completed",
    summary: "nightly audit",
    result: "done",
    resultForm: "prose",
  },
};

describe("resolveBackgroundTaskNotificationOriginMeta", () => {
  it("单条：originMeta 整体透传，manifest 载荷保留", () => {
    const resolved = resolveBackgroundTaskNotificationOriginMeta([makeCommand(workflowOriginMeta)]);
    expect(resolved).toEqual(workflowOriginMeta);
  });

  it("批量轮：合成 title，刻意丢弃 workflowNotification（退回三基字段）", () => {
    const resolved = resolveBackgroundTaskNotificationOriginMeta([
      makeCommand(workflowOriginMeta),
      makeCommand({
        backgroundSource: "workflow",
        title: "hourly sweep",
        workId: "dwfrun-2",
        workflowNotification: {
          kind: "escalation",
          qid: "dwfq-2",
          actor: "poet",
          question: "继续吗？",
        },
      }),
    ]);
    // 复用首个任务的展示锚点，title 合成 `a · b`。
    expect(resolved).toEqual({
      backgroundSource: "workflow",
      title: "nightly audit · hourly sweep",
      workId: "dwfrun-1",
    });
    // 载荷不得随批量轮搭车——「一轮一张 manifest」在批量下不成立。
    expect(resolved?.workflowNotification).toBeUndefined();
  });
});

const originalBinding: ManagedBillingBinding = {
  origin: "https://account.example.invalid",
  accountRef: "synthetic-account-a",
  accountEpoch: 1,
  policyRevision: "synthetic-scope",
};

describe("后台任务唤醒的创建轮扣费归属", () => {
  it.each([
    {
      eventType: "escalation-raised",
      payload: {
        qid: "synthetic-question",
        question: "synthetic question",
        actorName: "synthetic actor",
      },
    },
    { eventType: "run-stalled", payload: { sinceMs: 1, reason: "synthetic pause" } },
    {
      eventType: "hole-reached",
      payload: { instance: { siteId: "synthetic-site", ordinal: 1 }, name: "synthetic hole" },
    },
  ])(
    "tracker 尚未登记时 $eventType 使用 run 冻结绑定，不把它写入事件载荷",
    async ({ eventType, payload }) => {
      const observed: (ManagedBillingBinding | undefined)[] = [];
      const events: SessionEvent[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId(`managed-early-progress-${eventType}`),
        { titleGeneration: { enabled: false }, memory: { enabled: false } },
        {
          eventStore: createTestSessionEventStore(),
          providerRuntimeHeadersPort: {
            refreshBeforeModelRequest: async () => ({ headersApplied: true }),
          },
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              observed.push(observation.factoryInput.requestDependencies?.billingBinding);
              return { text: "synthetic completion", finishReason: "stop", usage: {} };
            },
          }),
        },
      ) as unknown as AgentRuntimeInternal;
      runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
      try {
        expect(runtime.runtimeTaskRegistry.get("unregistered-run")).toBeUndefined();
        await runtime.recordDynamicWorkflowRunProgress(
          { runId: "unregistered-run", sequence: 1, eventType, payload },
          { billingBinding: originalBinding },
        );
        await vi.waitFor(() => expect(runtime.runtimeCommandDrainActive).toBe(false));
        expect(observed).toEqual([originalBinding]);
        const progressEvent = events.find(
          (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
        );
        expect(progressEvent?.payload).not.toHaveProperty("billingBinding");
        expect(progressEvent?.payload).not.toHaveProperty("billingScope");
      } finally {
        await runtime.close();
      }
    },
  );

  it("真实 Agent 后台创建/子轮完成/父轮空闲唤醒全链保留 admission 绑定", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-managed-background-"));
    const childStarted = Promise.withResolvers<void>();
    const finishChild = Promise.withResolvers<void>();
    const observed: { source: string; billingBinding?: ManagedBillingBinding }[] = [];
    const outcomes: unknown[] = [];
    let parentCalls = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("managed-real-agent-background"),
      {
        mode: "yolo",
        workingDirectory: directory,
        titleGeneration: { enabled: false },
        memory: { enabled: false },
        subagents: { outputRootDir: directory },
      },
      {
        eventStore: createTestSessionEventStore(),
        providerRuntimeHeadersPort: {
          refreshBeforeModelRequest: async () => ({ headersApplied: true }),
          reportManagedOutcome: (input) => outcomes.push(input.outcome),
        },
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const child = observation.invocationContext?.metadata?.querySource === "subagent";
            observed.push({
              source: child ? "child" : "parent",
              billingBinding: observation.factoryInput.requestDependencies?.billingBinding,
            });
            if (child) {
              childStarted.resolve();
              await finishChild.promise;
              return { text: "synthetic child result", finishReason: "stop", usage: {} };
            }
            parentCalls += 1;
            return parentCalls === 1
              ? {
                  text: "",
                  finishReason: "tool-calls",
                  toolCalls: [
                    {
                      id: "synthetic-agent-tool",
                      name: "Agent",
                      input: {
                        description: "synthetic background task",
                        prompt: "synthetic child input",
                        subagent_type: "general-purpose",
                        run_in_background: true,
                      },
                    },
                  ],
                  usage: {},
                }
              : { text: "synthetic parent completion", finishReason: "stop", usage: {} };
          },
        }),
      },
    ) as unknown as AgentRuntimeInternal;
    try {
      await runtime.executeTurn("synthetic user input", undefined, {
        intent: { billingBinding: originalBinding },
      });
      await childStarted.promise;
      expect(runtime.activeForegroundExecution).toBeUndefined();
      const task = Object.values(runtime.runtimeTaskRegistry.all()).find(
        (candidate) => candidate.type === "local_agent",
      );
      expect(task?.billingBinding).toEqual(originalBinding);
      finishChild.resolve();
      await vi.waitFor(() => {
        expect(parentCalls).toBe(3);
        expect(runtime.runtimeCommandDrainActive).toBe(false);
      });
      expect(observed.map((call) => call.billingBinding)).toEqual(
        observed.map(() => originalBinding),
      );
      expect(observed.some((call) => call.source === "child")).toBe(true);
      expect(outcomes).toEqual(
        Array.from({ length: 3 }, () => ({
          kind: "turn_settled",
          billingBinding: originalBinding,
        })),
      );
    } finally {
      finishChild.resolve();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [true, "task-notification"],
    [true, "subagent-message"],
    [false, "task-notification"],
    [false, "subagent-message"],
  ] as const)("managed=%s，%s 在父轮结束后保留原归属", async (managed, mode) => {
    const calls: { billingBinding?: ManagedBillingBinding; hasRefresh: boolean }[] = [];
    const outcomes: unknown[] = [];
    const billingBinding = managed ? structuredClone(originalBinding) : undefined;
    let runtime: AgentRuntimeInternal;
    runtime = createTestAgentRuntime(
      createSessionId(`managed-wake-${managed}-${mode}`),
      { titleGeneration: { enabled: false }, memory: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        ...(managed
          ? {
              // 根端口没有默认绑定：原绑定来自输入 admission，不从当前账户端口补签。
              providerRuntimeHeadersPort: {
                refreshBeforeModelRequest: async () => ({ headersApplied: true }),
                reportManagedOutcome: (input: { outcome: unknown }) => outcomes.push(input.outcome),
              },
            }
          : {}),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            calls.push({
              billingBinding: observation.factoryInput.requestDependencies?.billingBinding,
              hasRefresh: !!observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt,
            });
            if (calls.length === 1) {
              runtime.runtimeTaskRegistry.register({
                taskId: "synthetic-task",
                startedAt: new Date(),
                status: "completed",
                type: "local_agent",
              });
            }
            return { text: "synthetic completion", finishReason: "stop", usage: {} };
          },
        }),
      },
    ) as unknown as AgentRuntimeInternal;
    try {
      await runtime.executeTurn("synthetic input", undefined, {
        ...(billingBinding ? { intent: { billingBinding } } : {}),
      });
      expect(runtime.activeForegroundExecution).toBeUndefined();
      expect(runtime.runtimeTaskRegistry.get("synthetic-task")?.billingBinding).toEqual(
        billingBinding,
      );
      if (mode === "task-notification") {
        runtime.enqueueBackgroundTaskNotification({
          taskId: "synthetic-task",
          text: "synthetic background result",
          traceContext: runtime.rootTraceContext,
        });
      } else {
        runtime.enqueueSubagentMessage({
          agentId: "synthetic-task",
          agentType: "general-purpose",
          childSessionId: "synthetic-child",
          childToolCallId: "synthetic-child-tool",
          responseId: "synthetic-response",
          summary: "synthetic report",
          message: "synthetic child result",
          traceContext: runtime.rootTraceContext,
        });
      }
      await vi.waitFor(() => expect(runtime.runtimeCommandDrainActive).toBe(false));
      expect(calls).toEqual([
        { billingBinding, hasRefresh: managed },
        { billingBinding, hasRefresh: managed },
      ]);
      expect(outcomes).toEqual(
        managed
          ? [
              { kind: "turn_settled", billingBinding },
              { kind: "turn_settled", billingBinding },
            ]
          : [],
      );
    } finally {
      await runtime.close();
    }
  });

  it("换号后的旧任务只携带原绑定，Host 拒绝时不进入模型请求且结算不归新账户", async () => {
    let currentBinding = structuredClone(originalBinding);
    const bindings: (ManagedBillingBinding | undefined)[] = [];
    const outcomes: unknown[] = [];
    let physicalAttempts = 0;
    let runtime: AgentRuntimeInternal;
    runtime = createTestAgentRuntime(
      createSessionId("managed-late-wake-account-switch"),
      { titleGeneration: { enabled: false }, memory: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        providerRuntimeHeadersPort: {
          async refreshBeforeModelRequest(input) {
            if (!sameManagedBillingBinding(input.managedAccess?.billingBinding, currentBinding))
              throw new Error("synthetic_account_scope_changed");
            return { headersApplied: true };
          },
          reportManagedOutcome: (input) => outcomes.push(input.outcome),
        },
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const billingBinding = observation.factoryInput.requestDependencies?.billingBinding;
            bindings.push(billingBinding);
            // 合成模型使用真实 runtime 反向鉴权端口；不发送任何网络请求。
            await observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({
              attempt: 1,
              managedAccess: { credentialRef: "agent", billingBinding: billingBinding! },
            });
            physicalAttempts += 1;
            runtime.runtimeTaskRegistry.register({
              taskId: "late-task",
              startedAt: new Date(),
              status: "completed",
              type: "local_agent",
            });
            return { text: "synthetic completion", finishReason: "stop", usage: {} };
          },
        }),
      },
    ) as unknown as AgentRuntimeInternal;
    try {
      await runtime.executeTurn("synthetic input", undefined, {
        intent: { billingBinding: originalBinding },
      });
      currentBinding = { ...originalBinding, accountRef: "synthetic-account-b", accountEpoch: 2 };
      runtime.enqueueBackgroundTaskNotification({
        taskId: "late-task",
        text: "synthetic late result",
        traceContext: runtime.rootTraceContext,
      });
      await vi.waitFor(() => expect(runtime.runtimeCommandDrainActive).toBe(false));
      expect(bindings).toEqual([originalBinding, originalBinding]);
      expect(physicalAttempts).toBe(1);
      expect(outcomes).toEqual([
        { kind: "turn_settled", billingBinding: originalBinding },
        { kind: "turn_settled", billingBinding: originalBinding },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("新账户活动轮留下旧任务通知，当前轮结束后队列只独立拒绝一次并排空", async () => {
    let currentBinding = structuredClone(originalBinding);
    const attemptedBindings: (ManagedBillingBinding | undefined)[] = [];
    let authorizedAttempts = 0;
    let runtime: AgentRuntimeInternal;
    runtime = createTestAgentRuntime(
      createSessionId("managed-active-foreign-wake-drains"),
      { titleGeneration: { enabled: false }, memory: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        providerRuntimeHeadersPort: {
          async refreshBeforeModelRequest(input) {
            if (!sameManagedBillingBinding(input.managedAccess?.billingBinding, currentBinding))
              throw new Error("synthetic_account_scope_changed");
            return { headersApplied: true };
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const billingBinding = observation.factoryInput.requestDependencies?.billingBinding;
            attemptedBindings.push(billingBinding);
            await observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({
              attempt: 1,
              managedAccess: { credentialRef: "agent", billingBinding: billingBinding! },
            });
            authorizedAttempts += 1;
            if (authorizedAttempts === 1) {
              runtime.runtimeTaskRegistry.register({
                taskId: "old-task",
                startedAt: new Date(),
                status: "completed",
                type: "local_agent",
              });
            } else if (authorizedAttempts === 2) {
              runtime.enqueueBackgroundTaskNotification({
                taskId: "old-task",
                text: "synthetic late result",
                traceContext: runtime.rootTraceContext,
              });
              const drained = await runtime.drainPendingRuntimeCommandsForActiveLoop();
              expect(drained.drained).toBe(0);
              expect(runtime.runtimeCommandQueue.size()).toBe(1);
            }
            return { text: "synthetic completion", finishReason: "stop", usage: {} };
          },
        }),
      },
    ) as unknown as AgentRuntimeInternal;
    try {
      await runtime.executeTurn("synthetic account a", undefined, {
        intent: { billingBinding: originalBinding },
      });
      currentBinding = { ...originalBinding, accountRef: "synthetic-account-b", accountEpoch: 2 };
      await runtime.executeTurn("synthetic account b", undefined, {
        intent: { billingBinding: currentBinding },
      });
      await vi.waitFor(() => expect(runtime.runtimeCommandDrainActive).toBe(false));
      expect(attemptedBindings).toEqual([originalBinding, currentBinding, originalBinding]);
      expect(authorizedAttempts).toBe(2);
      expect(runtime.runtimeCommandQueue.size()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it.each([false, true])("idle GUI/自动恢复同 workflow 只延续原绑定，换号=%s", async (switched) => {
    const terminal = Promise.withResolvers<{
      taskId: string;
      runId: string;
      startedAt: Date;
      status: "completed";
      output: string;
    }>();
    let currentBinding = structuredClone(originalBinding);
    const attemptedBindings: (ManagedBillingBinding | undefined)[] = [];
    let authorizedAttempts = 0;
    let runtime: AgentRuntimeInternal;
    runtime = createTestAgentRuntime(
      createSessionId(`managed-idle-workflow-resume-${switched}`),
      { titleGeneration: { enabled: false }, memory: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        dynamicWorkflowRunPort: {
          getTask: async () => ({
            taskId: "gui-resumed-run",
            runId: "gui-resumed-run",
            startedAt: new Date(0),
            status: "running",
          }),
          waitForTask: () => terminal.promise,
          cancel: async () => true,
        } as never,
        providerRuntimeHeadersPort: {
          async refreshBeforeModelRequest(input) {
            if (!sameManagedBillingBinding(input.managedAccess?.billingBinding, currentBinding))
              throw new Error("synthetic_account_scope_changed");
            return { headersApplied: true };
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const billingBinding = observation.factoryInput.requestDependencies?.billingBinding;
            attemptedBindings.push(billingBinding);
            await observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({
              attempt: 1,
              managedAccess: { credentialRef: "agent", billingBinding: billingBinding! },
            });
            authorizedAttempts += 1;
            if (authorizedAttempts === 1)
              runtime.runtimeTaskRegistry.register({
                taskId: "gui-resumed-run",
                startedAt: new Date(),
                status: "killed",
                type: "local_dynamic_workflow",
              });
            return { text: "synthetic completion", finishReason: "stop", usage: {} };
          },
        }),
      },
    ) as unknown as AgentRuntimeInternal;
    try {
      await runtime.executeTurn("synthetic original workflow", undefined, {
        intent: { billingBinding: originalBinding },
      });
      if (switched)
        currentBinding = { ...originalBinding, accountRef: "synthetic-account-b", accountEpoch: 2 };
      expect(runtime.activeForegroundExecution).toBeUndefined();
      await runtime.trackResumedDynamicWorkflowRun({ runId: "gui-resumed-run" });
      expect(runtime.runtimeTaskRegistry.get("gui-resumed-run")?.billingBinding).toEqual(
        originalBinding,
      );
      terminal.resolve({
        taskId: "gui-resumed-run",
        runId: "gui-resumed-run",
        startedAt: new Date(0),
        status: "completed",
        output: "synthetic result",
      });
      await vi.waitFor(() => {
        expect(attemptedBindings).toEqual([originalBinding, originalBinding]);
        expect(runtime.runtimeCommandDrainActive).toBe(false);
      });
      expect(authorizedAttempts).toBe(switched ? 1 : 2);
    } finally {
      terminal.resolve({
        taskId: "gui-resumed-run",
        runId: "gui-resumed-run",
        startedAt: new Date(0),
        status: "completed",
        output: "synthetic result",
      });
      await runtime.close();
    }
  });

  it.each(
    [undefined, originalBinding].flatMap((billingBinding) =>
      (["task-notification", "subagent-message"] as const).map((mode) => ({
        billingBinding,
        mode,
      })),
    ),
  )("活动轮只吸收同绑定的 $mode：$billingBinding", async ({ billingBinding, mode }) => {
    const runtime = createTestAgentRuntime(
      createSessionId(`managed-active-wake-${!!billingBinding}`),
      {},
      { eventStore: createTestSessionEventStore() },
    ) as unknown as AgentRuntimeInternal;
    runtime.activeForegroundExecution = {
      billingBinding,
      controller: new AbortController(),
      disposeParentAbort: () => {},
      foregroundExecutionId: "synthetic-foreground",
      preserveQueueAutoDrainOnCancel: false,
    };
    const foreignBinding = billingBinding
      ? { ...billingBinding, accountEpoch: 2 }
      : originalBinding;
    const makeScopedCommand = (binding: ManagedBillingBinding | undefined) => ({
      ...makeCommand(),
      billingBinding: binding,
      ...(mode === "subagent-message"
        ? {
            mode,
            source: "subagent_message" as const,
            responseId: "synthetic-response",
            agentId: "synthetic-agent",
            agentType: "general-purpose",
            childSessionId: "synthetic-child",
            childToolCallId: "synthetic-child-tool",
            summary: "synthetic report",
            messageLength: 1,
          }
        : {}),
    });
    const same = makeScopedCommand(billingBinding);
    const foreign = makeScopedCommand(foreignBinding);
    runtime.runtimeCommandQueue.enqueue(same);
    runtime.runtimeCommandQueue.enqueue(foreign);
    try {
      const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();
      expect(result.consumedCommandIds).toEqual([same.id]);
      expect(runtime.runtimeCommandQueue.snapshot().map((command) => command.id)).toEqual([
        foreign.id,
      ]);
    } finally {
      runtime.runtimeCommandQueue.removeById(foreign.id);
      runtime.activeForegroundExecution = undefined;
      await runtime.close();
    }
  });
});
