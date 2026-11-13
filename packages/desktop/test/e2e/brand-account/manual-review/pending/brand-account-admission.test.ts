/**
 * AW20: Host RPC publication boundary acceptance, without engine/model/payment IO.
 * pnpm --filter @zcode/desktop exec tsx --test test/e2e/brand-account/manual-review/pending/brand-account-admission.test.ts
 * Pending review: this does not replace native desktop or inference acceptance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IChannelServer, IServerChannel } from "@zcode/rpc";
import type { BrandAccountSnapshot } from "@zcode/services";
import {
  ServiceCollection,
  IBrandAccountService,
  IZCodeAgentService,
  IZCodeTaskService,
  IOffPeakTaskService,
  IPluginUiSamplingService,
} from "@zcode/services";

const policyModule = new URL(
  "../../../../../src/host/windowHostAttachmentRpcPolicy.ts",
  import.meta.url,
).href;
const { exposeWindowHostAttachmentServices } = (await import(policyModule)) as {
  exposeWindowHostAttachmentServices(params: {
    server: IChannelServer;
    services: ServiceCollection;
    clientMode: "desktop-continuous" | "web-remote-replayable";
    attachmentScope: { kind: "local" | "remote" | "source-settings" };
  }): void;
};

for (const scenario of [
  {
    mode: "desktop-continuous",
    scope: "local",
    brand: true,
    status: "signedOut",
    inference: "signedOut",
    blocked: true,
  },
  {
    mode: "desktop-continuous",
    scope: "local",
    brand: true,
    status: "authenticated",
    inference: "connecting",
    blocked: true,
  },
  {
    mode: "desktop-continuous",
    scope: "local",
    brand: true,
    status: "authenticated",
    inference: "unavailable",
    blocked: true,
  },
  {
    mode: "desktop-continuous",
    scope: "local",
    brand: true,
    status: "expired",
    inference: "configured",
    blocked: true,
  },
  {
    mode: "desktop-continuous",
    scope: "local",
    brand: true,
    status: "authenticated",
    inference: "configured",
    blocked: false,
  },
  {
    mode: "desktop-continuous",
    scope: "local",
    brand: false,
    status: "signedOut",
    inference: "signedOut",
    blocked: false,
  },
  {
    mode: "desktop-continuous",
    scope: "remote",
    brand: true,
    status: "signedOut",
    inference: "signedOut",
    blocked: false,
  },
  {
    mode: "desktop-continuous",
    scope: "source-settings",
    brand: true,
    status: "signedOut",
    inference: "signedOut",
    blocked: false,
  },
  {
    mode: "web-remote-replayable",
    scope: "local",
    brand: true,
    status: "signedOut",
    inference: "signedOut",
    blocked: false,
  },
] as const) {
  test(`AW20/MI04 ${scenario.mode}/${scenario.scope}/brand=${scenario.brand}/${scenario.status}/${scenario.inference}`, async () => {
    let calls = 0;
    const service = new Proxy(
      {},
      {
        get: () => async () => {
          calls += 1;
          return "delegated";
        },
      },
    );
    const services = new ServiceCollection()
      .register(IZCodeAgentService, service as IZCodeAgentService)
      .register(IZCodeTaskService, service as IZCodeTaskService);
    if (scenario.brand)
      services.register(IBrandAccountService, {
        getSnapshot: async () =>
          ({
            status: scenario.status,
            inference: { status: scenario.inference, error: null },
          }) as BrandAccountSnapshot,
      } as IBrandAccountService);
    const channels = new Map<string, IServerChannel>();
    exposeWindowHostAttachmentServices({
      server: { registerChannel: (name, channel) => channels.set(name, channel) },
      services,
      clientMode: scenario.mode,
      attachmentScope: { kind: scenario.scope },
    });
    const agent = channels.get(IZCodeAgentService.channelName);
    const task = channels.get(IZCodeTaskService.channelName);
    assert.ok(agent);
    assert.ok(task);
    const rejected = (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "brand_inference_not_ready" &&
      "kind" in error &&
      error.kind === "feature_disabled";
    for (const type of [
      "createSession",
      "sendText",
      "retryTurn",
      "editUserQuery",
      "resumeGoal",
      "sendQueuedNow",
      "compact",
    ]) {
      const invocation: Promise<string> = agent.call<string>("AW20", "sendConversationCommandV4", [
        { envelope: { type, payload: {} } },
      ]);
      if (scenario.blocked) await assert.rejects(invocation, rejected);
      else assert.equal(await invocation, "delegated");
    }
    for (const command of [
      "createTask",
      "sendPrompt",
      "enqueueTaskCommand",
      "promoteTaskCommand",
    ]) {
      const invocation: Promise<string> = task.call<string>("AW20", command, [{}]);
      if (scenario.blocked) await assert.rejects(invocation, rejected);
      else assert.equal(await invocation, "delegated");
    }
    if (scenario.blocked) assert.equal(calls, 0, "rejected requests never reach runtime admission");
    for (const type of ["stop", "cancelBackgroundWork", "pauseGoal", "deleteQueueItem"]) {
      assert.equal(
        await agent.call("AW20", "sendConversationCommandV4", [
          { envelope: { type, payload: {} } },
        ]),
        "delegated",
      );
    }
    assert.equal(await task.call("AW20", "getTaskSnapshot", [{}]), "delegated");
    if (scenario.mode === "web-remote-replayable")
      assert.equal(channels.has(IBrandAccountService.channelName), false);
  });
}

test("MI06/14: configured local brand rejects unmanaged inference entries but keeps stop/read controls", async () => {
  const calls: string[] = [];
  const service = new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        calls.push(String(name));
        return "delegated";
      },
    },
  );
  const services = new ServiceCollection()
    .register(IZCodeAgentService, service as IZCodeAgentService)
    .register(IZCodeTaskService, service as IZCodeTaskService)
    .register(IOffPeakTaskService, service as IOffPeakTaskService)
    .register(IPluginUiSamplingService, service as IPluginUiSamplingService)
    .register(IBrandAccountService, {
      getSnapshot: async () =>
        ({
          status: "authenticated",
          inference: { status: "configured", error: null },
        }) as BrandAccountSnapshot,
    } as IBrandAccountService);
  const channels = new Map<string, IServerChannel>();
  exposeWindowHostAttachmentServices({
    server: { registerChannel: (name, channel) => channels.set(name, channel) },
    services,
    clientMode: "desktop-continuous",
    attachmentScope: { kind: "local" },
  });
  const agent = channels.get(IZCodeAgentService.channelName)!;
  const task = channels.get(IZCodeTaskService.channelName)!;
  const offPeak = channels.get(IOffPeakTaskService.channelName)!;
  const sampling = channels.get(IPluginUiSamplingService.channelName)!;
  assert(agent && task && offPeak && sampling);
  const rejected = (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "brand_inference_entry_unavailable" &&
    "kind" in error &&
    error.kind === "feature_disabled";
  for (const command of [
    "generateWorkspaceText",
    "testModelConnectivity",
    "sampleMcpApp",
    "createAutomation",
    "updateAutomation",
    "runAutomationNow",
    "restartAutomation",
  ])
    await assert.rejects(agent.call("MI14", command, [{}]), rejected);
  await assert.rejects(agent.call("MI14", "setAutomationEnabled", [{ enabled: true }]), rejected);
  await assert.rejects(
    agent.call("MI14", "controlOffPeakExecutionV4", [{ control: { action: "start" } }]),
    rejected,
  );
  for (const command of ["submitBotGroupInput", "deliverSessionMessage"])
    await assert.rejects(task.call("MI14", command, [{}]), rejected);
  for (const command of ["createTask", "continueTask"])
    await assert.rejects(offPeak.call("MI14", command, [{}]), rejected);
  await assert.rejects(sampling.call("MI14", "sample", [{}]), rejected);
  await assert.rejects(
    agent.call("MI14", "sendConversationCommandV4", [
      { envelope: { type: "E2E_MI14_UNKNOWN_COMMAND", payload: {} } },
    ]),
    rejected,
  );
  for (const type of ["startSavedWorkflow", "resumeWorkflowRun", "amendWorkflowRunSettings"])
    await assert.rejects(
      agent.call("MI14", "sendConversationCommandV4", [{ envelope: { type, payload: {} } }]),
      rejected,
    );
  assert.deepEqual(calls, [], "Unmanaged requests never reach services even while configured");
  for (const [channel, command, args] of [
    [agent, "setAutomationEnabled", [{ enabled: false }]],
    [agent, "controlOffPeakExecutionV4", [{ control: { action: "cancel" } }]],
    [offPeak, "cancelTask", [{}]],
    [task, "getTaskSnapshot", [{}]],
  ] as const)
    assert.equal(await channel.call("MI14", command, args), "delegated");
  assert.equal(calls.length, 4);
});
