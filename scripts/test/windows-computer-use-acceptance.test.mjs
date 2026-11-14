import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  AcceptanceMcpClient,
  findFixtureInput,
  parseCellResult,
  requireNativeResult,
} from "../windows-computer-use-acceptance.mjs";

let directory;
let server;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "milocode-cua-acceptance-transport-"));
  server = join(directory, "protocol-fixture.mjs");
  await writeFile(
    server,
    String.raw`
import readline from "node:readline";
let echoCalls = 0;
let cancelled = 0;
const lines = readline.createInterface({input:process.stdin});
for await (const line of lines) {
  const message = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\n");
  if (message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" || !message.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]) throw new Error("Modern protocol request envelope is missing");
  if (message.method === "server/discover") reply({supportedVersions:["2026-07-28"],capabilities:{tools:{}}});
  else if (message.method === "echo") {
    echoCalls++;
    const value = "汉字😀".repeat(12000);
    const bytes = Buffer.from(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{value}})+"\n");
    const split = bytes.indexOf(Buffer.from("汉"))+1;
    process.stdout.write(bytes.subarray(0,split));
    setTimeout(()=>process.stdout.write(bytes.subarray(split)),5);
  }
  else if (message.method === "counts") reply({echoCalls,cancelled});
  else if (message.method === "rpc-error") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32602,message:"invalid native input"}})+"\n");
  else if (message.method === "no-result") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id})+"\n");
  else if (message.method === "invalid-json") process.stdout.write("not JSON\n");
  else if (message.method === "exit") process.exit(9);
  else if (message.method === "notifications/cancelled") cancelled++;
}
`,
  );
});
after(async () => await rm(directory, { recursive: true, force: true }));

async function withClient(run) {
  const client = new AcceptanceMcpClient(process.execPath, [server]);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test("actual stdio transport negotiates the installed protocol and reconstructs split UTF-8 beyond 64 KiB", async () => {
  await withClient(async (client) => {
    await client.initialize();
    const response = await client.request("echo", {});
    assert.equal(response.value, "汉字😀".repeat(12000));
    assert.equal((await client.request("counts", {})).echoCalls, 1);
  });
});

test("RPC errors and missing results fail instead of becoming successful native observations", async () => {
  await withClient(async (client) => {
    await assert.rejects(client.request("rpc-error", {}), /invalid native input/u);
    await assert.rejects(client.request("no-result", {}), /lacks a result/u);
  });
});

test("a timed-out operation sends one cancellation and is never automatically retried", async () => {
  await withClient(async (client) => {
    await assert.rejects(client.request("never-reply", {}, 30), /acceptance deadline/u);
    const counts = await client.request("counts", {});
    assert.equal(counts.cancelled, 1);
    assert.equal(counts.echoCalls, 0);
  });
});

test("malformed JSON and premature process exit fail outstanding calls", async () => {
  await withClient(async (client) => {
    await assert.rejects(client.request("invalid-json", {}), /invalid JSON/u);
  });
  await withClient(async (client) => {
    await assert.rejects(client.request("exit", {}), /code 9/u);
  });
});

test("only one SDK result is accepted and actual SDK failures retain their diagnostic", () => {
  const envelope = { structuredContent: { ok: true, data: { name: "汉字😀" } } };
  const text = `MILOCODE_CUA_ACCEPTANCE_JSON:${JSON.stringify(envelope)}`;
  assert.deepEqual(parseCellResult({ content: [{ type: "text", text }] }), envelope);
  assert.throws(
    () => parseCellResult({ isError: true, content: [{ type: "text", text: "PERM_DENIED" }] }),
    /PERM_DENIED/u,
  );
  assert.throws(
    () => parseCellResult({ content: [{ type: "text", text: `${text}\n${text}` }] }),
    /exactly one/u,
  );
  assert.throws(
    () =>
      requireNativeResult(
        { structuredContent: { ok: false, error: { code: "ACTION_FAILED" } } },
        "typing",
      ),
    /success envelope/u,
  );
});

test("actions require a unique qualified ref from the exact self-created fixture window", () => {
  const title = "MiloCodeCuaFixture-0123456789ab";
  const input = {
    role: "textfield",
    name: "MiloCode CUA test input",
    ref_id: "@s123:e2",
    value: "",
  };
  const data = { complete: true, window: { title }, tree: { role: "window", children: [input] } };
  assert.equal(findFixtureInput(data, title), input);
  assert.throws(
    () => findFixtureInput({ ...data, window: { title: "different app" } }, title),
    /different window/u,
  );
  assert.throws(() => findFixtureInput({ ...data, complete: false }, title), /incomplete/u);
  assert.throws(
    () => findFixtureInput({ ...data, tree: { children: [input, { ...input }] } }, title),
    /uniquely identified/u,
  );
  assert.throws(
    () => findFixtureInput({ ...data, tree: { children: [{ ...input, ref_id: "@e2" }] } }, title),
    /qualified/u,
  );
});
