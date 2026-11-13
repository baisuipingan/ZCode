/**
 * MI04/07/09: real Host service + stdio protocol client; only CLI ACKs are synthetic.
 * No model, account network, payment, or native desktop acceptance is claimed here.
 * pnpm --filter @zcode/desktop exec tsx --test test/e2e/brand-account/manual-review/pending/brand-managed-delivery.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { ProviderConfigMap, type ModelSelectionView } from "@zcode/provider";
import { managedProviderPolicySchema, type ManagedProviderPolicy } from "@zcode/shared";
import { createZCodeAgentService } from "@zcode/services/node";
import type { BrandManagedInferenceHost } from "../../../../../../services/src/brand-account/index.js";

// A delayed configuration reply keeps the real stdio request in flight, while later requests
// (including stop) remain independently observable. It never constructs an inference client.
const CLI = String.raw`
const { createInterface } = require('node:readline');
const { appendFile, access } = require('node:fs/promises');
const { setTimeout: pause } = require('node:timers/promises');
const log = process.env.MI_DELIVERY_LOG;
const release = process.env.MI_DELIVERY_RELEASE;
const send = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\n');
createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line);
  if (!message.method || !('id' in message)) return;
  await appendFile(log, JSON.stringify({method:message.method, params:message.params}) + '\n');
  const p = message.params;
  if (message.method === 'provider/updateAccountConfig') {
    if (process.env.MI_DELIVERY_HOLD === '1' && p.managedPolicy?.state === 'ready' && p.managedPolicy.billingBinding.accountRef === 'A') {
      while (true) { try { await access(release); break; } catch { await pause(5); } }
    }
    const ack = {receivedRevision:p.revision, providerCount:0, status:'received'};
    if (process.env.MI_DELIVERY_ACK !== 'missing-applied') ack.appliedRevision=p.revision;
    ack.managedReady=process.env.MI_DELIVERY_ACK !== 'not-ready';
    send(message.id, ack);
  } else if (message.method === 'provider/refreshRegistry') send(message.id, {refreshed:true});
  else if (message.method === 'runtime/capabilities') send(message.id, {});
  else if (message.method === 'v4/command') {
    send(message.id, {commandId:p.commandId, status:'accepted', revisionAtDecision:1});
    if (process.env.MI_DELIVERY_OUTCOME === '1') {
      const binding = {origin:'https://account.example',accountRef:'A',accountEpoch:1,policyRevision:'policy:1'};
      const params = {sessionId:'session',workspace:{workspacePath:process.env.MI_DELIVERY_WORKSPACE,workspaceKey:process.env.MI_DELIVERY_WORKSPACE},outcome:{kind:'turn_settled',billingBinding:binding}};
      const notify = value => process.stdout.write(JSON.stringify({method:'interaction/managedInferenceOutcome',params:value})+'\n');
      notify({...params, outcome:{...params.outcome,key:'must-not-forward'}});
      notify({...params,workspace:{...params.workspace,workspaceIdentity:'ssh:other:/work'}});
      notify({...params,workspace:{...params.workspace,remoteSessionId:'remote-session'}});
      notify(params);
    }
  }
  else if (message.method === 'workspace/readPresentation') send(message.id, {workspace:p.workspace, mode:'build', slashCommands:[]});
  else process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:'synthetic method unavailable'}})+'\n');
});
`;

function ready(accountRef: string): ManagedProviderPolicy {
  return managedProviderPolicySchema.parse({
    state: "ready",
    revision: `${accountRef}:policy:1`,
    billingBinding: {
      origin: "https://account.example",
      accountRef,
      accountEpoch: accountRef === "A" ? 1 : 2,
      policyRevision: "policy:1",
    },
    providerId: "milorouter-managed",
    credentialRef: "milorouter:workbench",
    baseUrl: "https://account.example/v1",
    defaultSelection: {
      providerId: "milorouter-managed",
      modelId: "model",
      options: { reasoningLevel: "none" },
    },
    models: [
      {
        modelId: "model",
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
            reasoningLevel: { values: ["none"], map: "{}" },
            maxOutputTokens: { max: 8192, map: '{"max_output_tokens":maxOutputTokens}' },
          },
        },
      },
    ],
  });
}

async function setup(
  options: {
    hold?: boolean;
    ack?: string;
    blocked?: boolean;
    outcome?: boolean;
    ambient?: {
      started: { promise: Promise<void>; resolve(): void };
      finish: { promise: Promise<void>; resolve(): void };
    };
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "brand-managed-delivery-"));
  const logPath = join(directory, "requests.jsonl");
  const releasePath = join(directory, "release");
  await writeFile(logPath, "");
  let policy = options.blocked ? { state: "blocked" as const, revision: "signed-out" } : ready("A");
  let sourceRevision = 0;
  const listeners = new Set<(reason: string) => void>();
  let assertionCount = 0;
  const outcomes: unknown[] = [];
  const inference: BrandManagedInferenceHost = {
    async reportOutcome(outcome) {
      outcomes.push(outcome);
    },
    getPolicy: () => structuredClone(policy),
    onDidChange: () => () => {},
    async assertConfigured() {
      assertionCount += 1;
      if (policy.state !== "ready")
        throw Object.assign(new Error("signed out"), { code: "brand_inference_not_ready" });
    },
    async resolve() {
      throw new Error("no inference in delivery test");
    },
    async ensureFreshForAdmission() {
      await inference.assertConfigured();
    },
    async assertAdmissionIdentity() {
      await inference.assertConfigured();
    },
    async readUsageScope() {
      throw new Error("no usage in delivery test");
    },
  };
  const agent = createZCodeAgentService({
    commandResolver: () => ({
      command: process.execPath,
      args: ["-e", CLI],
      env: {
        MI_DELIVERY_LOG: logPath,
        MI_DELIVERY_RELEASE: releasePath,
        MI_DELIVERY_HOLD: options.hold ? "1" : "0",
        MI_DELIVERY_ACK: options.ack ?? "ready",
        MI_DELIVERY_OUTCOME: options.outcome ? "1" : "0",
        MI_DELIVERY_WORKSPACE: directory,
      },
    }),
    requestTimeoutMs: 5000,
    ...(options.ambient
      ? {
          browserControlExecutor: {
            async list() {
              options.ambient!.started.resolve();
              await options.ambient!.finish.promise;
              return [];
            },
            async execute() {
              return { ok: false };
            },
          },
        }
      : {}),
    brandManagedInference: inference,
    accountProviderConfigSource: {
      async read() {
        return {
          revision: `source:${sourceRevision}:${policy.revision}`,
          basedOnZCodeBuiltinRevision: "managed",
          providers: ProviderConfigMap.empty(),
          states: {},
          managedPolicy: structuredClone(policy),
        };
      },
      onDidChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    modelSelectionReadinessSource: {
      getView: async () =>
        ({
          revision: 1,
          providers: [{ providerId: "milorouter-managed", models: [{ modelId: "model" }] }],
        }) as unknown as ModelSelectionView,
    },
  });
  async function requests(): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return {
    agent,
    workspacePath: directory,
    requests,
    outcomes,
    get assertions() {
      return assertionCount;
    },
    release: () => writeFile(releasePath, "release"),
    change(next: ManagedProviderPolicy) {
      policy = next;
      sourceRevision += 1;
      for (const listener of listeners) listener("test-account-changed");
    },
    async waitForConfiguration() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await requests()).some((request) => request.method === "provider/updateAccountConfig"))
          return;
        await pause(5);
      }
      throw new Error("Host did not deliver configuration to CLI");
    },
    async close() {
      await writeFile(releasePath, "release");
      await agent.disposeAllAndWait();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function send(f: Awaited<ReturnType<typeof setup>>, type: "sendText" | "stop" = "sendText") {
  return f.agent.sendConversationCommandV4({
    workspacePath: f.workspacePath,
    envelope: {
      commandId: `command:${type}`,
      sessionId: "session",
      clientId: "desktop",
      issuedAt: 1,
      baseRevision: 0,
      type,
      payload: type === "sendText" ? { text: "synthetic input" } : {},
    },
  });
}

for (const change of ["logout", "account-B"] as const)
  test(
    `MI04/07 late A applied ACK after ${change} cannot admit execution`,
    { timeout: 15000 },
    async () => {
      const f = await setup({ hold: true });
      try {
        const pending = send(f);
        const rejected = assert.rejects(pending, /变化|signed out|inference/u);
        await f.waitForConfiguration();
        f.change(change === "logout" ? { state: "blocked", revision: "logout" } : ready("B"));
        await f.release();
        await rejected;
        assert(!(await f.requests()).some((request) => request.method === "v4/command"));
      } finally {
        await f.close();
      }
    },
  );

test(
  "MI07 A input cannot become B authorization during post-sync browser preflight",
  { timeout: 15000 },
  async () => {
    const ambient = {
      started: Promise.withResolvers<void>(),
      finish: Promise.withResolvers<void>(),
    };
    const f = await setup({ ambient });
    try {
      const pending = send(f);
      const rejected = assert.rejects(pending, /变化/u);
      await ambient.started.promise;
      f.change(ready("B"));
      ambient.finish.resolve();
      await rejected;
      assert(!(await f.requests()).some((request) => request.method === "v4/command"));
    } finally {
      ambient.finish.resolve();
      await f.close();
    }
  },
);

for (const type of ["resumeGoal", "setAutoDrain", "resolveInteraction"] as const)
  test(`MI04 ${type} also requires the CLI applied ACK`, { timeout: 15000 }, async () => {
    const f = await setup({ ack: "missing-applied" });
    try {
      await assert.rejects(
        f.agent.sendConversationCommandV4({
          workspacePath: f.workspacePath,
          envelope: {
            commandId: `command:${type}`,
            sessionId: "session",
            clientId: "desktop",
            issuedAt: 1,
            baseRevision: 0,
            type,
            payload: type === "setAutoDrain" ? { autoDrain: true } : {},
          },
        }),
        /尚未应用/u,
      );
      assert(
        (await f.requests()).some((request) => request.method === "provider/updateAccountConfig"),
      );
      assert(!(await f.requests()).some((request) => request.method === "v4/command"));
    } finally {
      await f.close();
    }
  });

for (const ack of ["missing-applied", "not-ready"])
  test(`MI04 ${ack} is insufficient for execution`, { timeout: 15000 }, async () => {
    const f = await setup({ ack });
    try {
      await assert.rejects(send(f), /尚未应用/u);
      assert(!(await f.requests()).some((request) => request.method === "v4/command"));
    } finally {
      await f.close();
    }
  });

test("MI04 matching applied ready ACK admits exactly one command", { timeout: 15000 }, async () => {
  const f = await setup();
  try {
    assert.equal((await send(f)).status, "accepted");
    assert.equal(
      (await f.requests()).filter((request) => request.method === "v4/command").length,
      1,
    );
    assert(f.assertions > 0);
  } finally {
    await f.close();
  }
});

test(
  "MI07 signed-out read and stop stay available without inference authorization",
  { timeout: 15000 },
  async () => {
    const f = await setup({ blocked: true });
    try {
      assert.equal(
        (await f.agent.readWorkspacePresentation({ workspacePath: f.workspacePath })).mode,
        "build",
      );
      assert.equal((await send(f, "stop")).status, "accepted");
      assert.equal(f.assertions, 0);
    } finally {
      await f.close();
    }
  },
);

test("RC03: real Host accepts local private outcome and drops malformed/remote identity feedback", async () => {
  const f = await setup({ outcome: true });
  try {
    await send(f);
    const deadline = Date.now() + 3000;
    while (!f.outcomes.length && Date.now() < deadline) await pause(5);
    assert.deepEqual(f.outcomes, [
      {
        kind: "turn_settled",
        billingBinding: {
          origin: "https://account.example",
          accountRef: "A",
          accountEpoch: 1,
          policyRevision: "policy:1",
        },
      },
    ]);
  } finally {
    await f.close();
  }
});
