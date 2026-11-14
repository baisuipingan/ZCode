import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
} from "../index.js";
import { createComputerUseRuntime } from "../index.js";
import {
  createAgentDesktopRuntime,
  getAgentDesktopPermissionStatus,
} from "../src/agent-desktop/index.js";

const context: ComputerUseRuntimeContext = {
  sessionId: "test-session",
  runtimeScope: "main",
  workspaceKey: "/example",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
};

// This executable only implements a fake protocol. It never observes or controls the desktop.
const fakeNative = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
const home=process.env.AGENT_DESKTOP_HOME;
const args=process.argv.slice(2);
const homeExisted=fs.existsSync(home);
fs.mkdirSync(home,{recursive:true});
const log=(x)=>fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify(x)+'\n');
log({event:'spawn',args,pid:process.pid,homeExisted,homeMode:fs.statSync(home).mode&0o777});
if(args[0]==='session'){
 const id='run-'+randomUUID();
 fs.mkdirSync(path.join(home,'sessions',id),{recursive:true});
 console.log(JSON.stringify({ok:true,data:{session_id:id}}));
 process.exit(0);
}
const session=args[args.indexOf('--session')+1];
const headed=args.includes('--headed');
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const tools=[
 {name:'desktop_snapshot',inputSchema:schema({app:{type:'string'}})},
 {name:'desktop_click',inputSchema:schema({ref_id:{type:'string'}},['ref_id'])},
 {name:'desktop_screenshot',inputSchema:schema({output_path:{type:'string'}})},
 {name:'desktop_permissions',inputSchema:schema({request:{type:'boolean'},guide:{type:'boolean'}})},
 {name:'desktop_launch',inputSchema:schema({app:{type:'string'},activate:{type:'boolean'},args:{type:'array'},env:{type:'array'},cwd:{type:'string'}},['app'])},
 {name:'desktop_press',inputSchema:schema({combo:{type:'string'},force:{type:'boolean'}},['combo'])},
 {name:'desktop_wait',inputSchema:schema({ms:{type:'integer'}})},
 {name:'desktop_sandbox_exec',inputSchema:schema({command:{type:'string'}})},
 {name:'desktop_session_gc',inputSchema:schema()},
 {name:'desktop_key_down',inputSchema:schema()},
 {name:'desktop_batch',inputSchema:schema()},
 {name:'desktop_get',inputSchema:schema({path:{type:'string'}},['path'])},
];
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){
 const m=JSON.parse(line);log(m);
 const send=(result)=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 if(m.method==='initialize')send({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.3.1'}});
 if(m.method==='tools/list')send({tools});
 if(m.method==='tools/call'){
  const {name,arguments:a}=m.params;
  if(name==='desktop_wait'){
   fs.writeFileSync(path.join(home,'waiting'),'1');
   await new Promise(r=>setTimeout(r,a.ms||300));
  }
  if(name==='desktop_permissions'){
   send({content:[],structuredContent:{ok:true,data:{accessibility:{state:'denied'},screen_recording:{state:'granted'},automation:{state:'not_required'}}}});continue;
  }
  if(name==='desktop_snapshot'){
   if(a.app==='unicode'){
    const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'汉字😀'}],structuredContent:{ok:true}}})+'\n');
    const split=bytes.indexOf(Buffer.from('汉'))+1;
    process.stdout.write(bytes.subarray(0,split));
    setTimeout(()=>process.stdout.write(bytes.subarray(split)),5);continue;
   }
   send({content:[{type:'text',text:'snapshot'}],structuredContent:{ok:true,data:{ref:'@'+session+':e1',session,headed}}});continue;
  }
  if(name==='desktop_click'&&a.ref_id!=='@'+session+':e1'){
   if(a.ref_id==='@not-delivered:e1'||a.ref_id==='@explicit-sent:e1'){
    send({content:[{type:'text',text:'native policy denied'}],isError:true,structuredContent:{ok:false,error:{code:'POLICY_DENIED',disposition:{delivery:'not_delivered',retry:'safe'},...(a.ref_id==='@explicit-sent:e1'?{possibly_sent:true}:{})}}});continue;
   }
   if(a.ref_id==='@malformed:e1'){send({});continue;}
   if(a.ref_id==='@text-only:e1'){send({content:[{type:'text',text:'original native startup failure'}],isError:true});continue;}
   if(a.ref_id==='@unknown:e1'){
    send({content:[{type:'text',text:'unknown delivery'}],structuredContent:{ok:false,error:{code:'NATIVE_FAILURE',message:'Original native message'}}});continue;
   }
   send({content:[{type:'text',text:'stale'}],isError:true,structuredContent:{ok:false,error:{code:'SNAPSHOT_NOT_FOUND',disposition:'not_delivered'}}});continue;
  }
  send({content:[{type:'text',text:'native-result'}],structuredContent:{ok:true,data:{session,headed,name}}});
 }
}
`;

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return String(address.port);
}

describe.skipIf(process.platform !== "darwin")(
  "agent-desktop runtime protocol and lifecycle",
  () => {
    let directory: string;
    let env: Record<string, string | undefined>;
    const runtimes: ComputerUseRuntime[] = [];
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "milocode-cua-test-"));
      const binary = join(directory, "native.mjs");
      await writeFile(binary, `#!${process.execPath}\n${fakeNative}`);
      await chmod(binary, 0o700);
      env = {
        ...process.env,
        MILOCODE_AGENT_DESKTOP_BINARY: binary,
        ZCODE_CUA_NODE_REPL_HOST: "1",
        MILOCODE_AGENT_DESKTOP_STATE_DIR: join(directory, "state"),
        MILOCODE_AGENT_DESKTOP_LOCK_PORT: await port(),
      };
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
      await rm(directory, { recursive: true, force: true });
    });
    function runtime(overrides = {}) {
      const value = createAgentDesktopRuntime({ env, ...overrides });
      runtimes.push(value);
      return value;
    }
    function call(
      value: ComputerUseRuntime,
      name: string,
      args: object = {},
      headed = false,
    ) {
      return value.execute({
        toolName: "desktop_call",
        arguments: { name, arguments: args, headed },
        context,
      });
    }
    async function homes() {
      return (
        await readdir(join(directory, "state", "runtime")).catch(() => [])
      ).map((id) => join(directory, "state", "runtime", id));
    }
    async function waitUntilWaiting() {
      for (let i = 0; i < 200; i++) {
        for (const home of await homes()) {
          if (await readFile(join(home, "waiting"), "utf8").catch(() => ""))
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Fixture never received the pending call");
    }

    it("uses trusted opt-in and denies remote/subagent/replayable contexts before launching", async () => {
      const untrusted = createComputerUseRuntime({
        env: { ...env, ZCODE_CUA_NODE_REPL_HOST: undefined },
      });
      runtimes.push(untrusted);
      expect(
        await untrusted.execute({ toolName: "desktop_tools", context }),
      ).toMatchObject({ isError: true });
      const value = runtime();
      for (const changed of [
        { runtimeScope: "subagent" as const },
        { remoteSessionId: "remote" },
        { workspaceIdentity: "remote:ssh:example:22:user:/work" },
        { clientMode: "web-remote-replayable" as const },
        { deliveryKind: "web-remote-replayable" as const },
      ]) {
        expect(
          await value.execute({
            toolName: "desktop_tools",
            context: { ...context, ...changed },
          }),
        ).toMatchObject({ isError: true });
      }
      expect(await homes()).toEqual([]);
    });

    it("leaves the Windows state-root leaf absent so the native provider can protect its ACL", async () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        const value = runtime();
        expect(await call(value, "desktop_snapshot")).toMatchObject({
          structuredContent: { ok: true },
        });
        const logs = (
          await readFile(join((await homes())[0], "calls.jsonl"), "utf8")
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        // 模拟的是上游目录创建合同；真实 Windows DACL 由最终安装包 runner 验证。
        expect(
          logs.find((item) => item.event === "spawn" && item.args[0] === "session"),
        ).toMatchObject({ homeExisted: false });
        await value.closeSession(context);
        expect(await homes()).toEqual([]);
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    });

    it("keeps the macOS state-root private before native session initialization", async () => {
      expect(await call(runtime(), "desktop_snapshot")).toMatchObject({
        structuredContent: { ok: true },
      });
      const logs = (
        await readFile(join((await homes())[0], "calls.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        logs.find((item) => item.event === "spawn" && item.args[0] === "session"),
      ).toMatchObject({ homeExisted: true, homeMode: 0o700 });
    });

    it("returns real filtered schemas and rejects hidden tools and dangerous arguments", async () => {
      const value = runtime();
      const catalog = await value.execute({
        toolName: "desktop_tools",
        context,
      });
      const tools = catalog.structuredContent?.tools as Array<{
        name: string;
        inputSchema: { properties: Record<string, unknown> };
      }>;
      expect(tools.map((tool) => tool.name)).toContain("desktop_snapshot");
      expect(tools.map((tool) => tool.name)).not.toContain(
        "desktop_sandbox_exec",
      );
      expect(tools.map((tool) => tool.name)).not.toContain("desktop_batch");
      expect(tools.map((tool) => tool.name)).not.toContain("desktop_get");
      expect(
        tools.find((tool) => tool.name === "desktop_screenshot")?.inputSchema
          .properties,
      ).toEqual({});
      expect(
        tools.find((tool) => tool.name === "desktop_permissions")?.inputSchema
          .properties,
      ).toEqual({});
      for (const [name, args] of [
        ["desktop_sandbox_exec", { command: "bad" }],
        ["desktop_key_down", {}],
        ["desktop_screenshot", { output_path: "/tmp/no" }],
        ["desktop_permissions", { request: true }],
        ["desktop_launch", { app: "Terminal", args: ["bad"] }],
        ["desktop_launch", { app: "/bin/sh" }],
        ["desktop_press", { combo: "cmd+c", force: true }],
        ["desktop_snapshot", { headed: true }],
      ] as const)
        expect(await call(value, name, args)).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "invalid_arguments" } },
        });
      expect(await call(value, "desktop_click", { ref_id: 123 })).toMatchObject(
        { isError: true },
      );
    });

    it("preserves native refs and errors across cells and an explicit headed client in one session", async () => {
      const value = runtime();
      const first = await call(value, "desktop_snapshot", { app: "Fixture" });
      const data = first.structuredContent?.data as {
        ref: string;
        session: string;
        headed: boolean;
      };
      expect(data.headed).toBe(false);
      expect(
        await call(value, "desktop_click", { ref_id: data.ref }, true),
      ).toMatchObject({
        structuredContent: {
          ok: true,
          data: { session: data.session, headed: true },
        },
      });
      expect(
        await call(value, "desktop_click", { ref_id: "@other:e1" }),
      ).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "SNAPSHOT_NOT_FOUND", disposition: "not_delivered" },
        },
      });
      expect(
        await call(value, "desktop_click", { ref_id: "@unknown:e1" }),
      ).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: "NATIVE_FAILURE",
            message: "Original native message",
            possibly_sent: true,
            dispatch_status: "possibly_sent",
          },
        },
      });
      const second = await call(value, "desktop_snapshot");
      expect(second.structuredContent).toMatchObject({
        data: { session: data.session, headed: false },
      });
      const logs = (
        await readFile(join((await homes())[0], "calls.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        logs.find(
          (item) => item.event === "spawn" && item.args[0] === "session",
        ).args,
      ).toContain("--no-trace");
      expect(
        logs.filter((item) => item.event === "spawn" && item.args[0] === "mcp"),
      ).toHaveLength(5);
      for (const item of logs.filter(
        (item) => item.event === "spawn" && item.args[0] === "mcp",
      )) {
        expect(() => process.kill(item.pid, 0)).toThrow();
      }
    });

    it("has immediate cross-runtime exclusion, and a busy call cannot kill the owner", async () => {
      const owner = runtime();
      const other = runtime();
      const pending = call(owner, "desktop_wait", { ms: 200 });
      await waitUntilWaiting();
      expect(await call(other, "desktop_snapshot")).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "busy" } },
      });
      expect(await pending).toMatchObject({ structuredContent: { ok: true } });
      expect(await call(other, "desktop_snapshot")).toMatchObject({
        structuredContent: { ok: true },
      });
    });

    it("cancels without retry, invalidates refs, removes state, and releases the OS lease", async () => {
      const value = runtime();
      const controller = new AbortController();
      const pending = value.execute({
        toolName: "desktop_call",
        arguments: { name: "desktop_wait", arguments: { ms: 30_000 } },
        context,
        signal: controller.signal,
      });
      await waitUntilWaiting();
      controller.abort();
      expect(await pending).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "cancelled",
            disposition: "possibly_sent",
            possibly_sent: true,
            dispatch_status: "possibly_sent",
            retryable: false,
          },
        },
      });
      expect(await homes()).toEqual([]);
      const other = runtime();
      expect(await call(other, "desktop_snapshot")).toMatchObject({
        structuredContent: { ok: true },
      });
    });

    it("stop interrupts the submitted call and later control starts with a fresh session", async () => {
      const value = runtime();
      const first = await call(value, "desktop_snapshot");
      const old = (first.structuredContent as { data: { session: string } })
        .data.session;
      const pending = call(value, "desktop_wait", { ms: 30_000 });
      await waitUntilWaiting();
      expect(
        await value.execute({ toolName: "desktop_stop", context }),
      ).toMatchObject({ structuredContent: { stopped: true } });
      expect(await pending).toMatchObject({
        isError: true,
        structuredContent: { error: { disposition: "possibly_sent" } },
      });
      expect(await homes()).toEqual([]);
      const next = await call(value, "desktop_snapshot");
      expect(
        (next.structuredContent as { data: { session: string } }).data.session,
      ).not.toBe(old);
      await value.closeSession(context);
      expect(await homes()).toEqual([]);
    });

    it("queries actual permission states without opt-in, native sessions, requests, or screenshots", async () => {
      const result = await getAgentDesktopPermissionStatus({
        ...env,
        ZCODE_CUA_NODE_REPL_HOST: undefined,
      });
      expect(result).toMatchObject({
        available: true,
        provider: "agent-desktop",
        accessibility: "denied",
        screenRecording: "granted",
        grantOwner: null,
        accessibilityProbeOk: false,
        screenCaptureProbeOk: false,
      });
      const log = (
        await readFile(join(directory, "state", "calls.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        log
          .filter((item) => item.method === "tools/call")
          .map((item) => item.params),
      ).toEqual([
        { name: "desktop_permissions", arguments: { request: false } },
      ]);
      expect(log.find((item) => item.event === "spawn")).toMatchObject({
        args: ["mcp"],
        homeExisted: false,
      });
    });

    it("retains delivery uncertainty for malformed native results and text-only errors", async () => {
      const value = runtime();
      expect(
        await call(value, "desktop_click", { ref_id: "@not-delivered:e1" }),
      ).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "POLICY_DENIED",
            disposition: { delivery: "not_delivered", retry: "safe" },
            possibly_sent: false,
            dispatch_status: "not_sent",
          },
        },
      });
      expect(
        await call(value, "desktop_click", { ref_id: "@explicit-sent:e1" }),
      ).toMatchObject({
        isError: true,
        structuredContent: {
          error: { possibly_sent: true, dispatch_status: "possibly_sent" },
        },
      });
      expect(
        await call(value, "desktop_click", { ref_id: "@text-only:e1" }),
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "original native startup failure" }],
        structuredContent: {
          error: {
            code: "native_error",
            message: "original native startup failure",
            possibly_sent: true,
          },
        },
      });
      expect(
        await call(value, "desktop_click", { ref_id: "@malformed:e1" }),
      ).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "invalid_response",
            possibly_sent: true,
            dispatch_status: "possibly_sent",
          },
        },
      });
    });

    it("preserves Chinese and emoji when native stdout splits a UTF-8 character", async () => {
      expect(
        await call(runtime(), "desktop_snapshot", { app: "unicode" }),
      ).toMatchObject({ content: [{ type: "text", text: "汉字😀" }] });
    });

    it("closeSession cancels admission before setup and releases its lease before returning", async () => {
      const value = runtime();
      const pending = value.execute({ toolName: "desktop_tools", context });
      await value.closeSession(context);
      expect(await pending).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "cancelled", possibly_sent: false },
        },
      });
      expect(await homes()).toEqual([]);
      expect(await call(runtime(), "desktop_snapshot")).toMatchObject({
        structuredContent: { ok: true },
      });
    });

    it("expires only inactive refs and rejects old refs in a fresh native namespace", async () => {
      const value = runtime();
      const first = await call(value, "desktop_snapshot");
      const ref = (first.structuredContent as { data: { ref: string } }).data
        .ref;
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
      expect(await call(value, "desktop_click", { ref_id: ref })).toMatchObject(
        {
          isError: true,
          structuredContent: {
            error: { code: "SNAPSHOT_NOT_FOUND", possibly_sent: false },
          },
        },
      );
      expect(await homes()).toHaveLength(1);
    });
  },
);
