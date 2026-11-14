import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_LIMIT = 32 * 1024 * 1024;
const RESULT_MARKER = "MILOCODE_CUA_ACCEPTANCE_JSON:";
const PROTOCOL_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "milocode-windows-cua-acceptance",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** 无第三方依赖的 stdio 验收客户端；运行的 server 和 SDK 必须来自最终安装目录。 */
export class AcceptanceMcpClient {
  constructor(command, args, options = {}) {
    this.child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.read(chunk));
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 16_384) this.stderr += chunk;
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code) => {
      this.closed = true;
      this.exitCode = code;
      this.fail(new Error(`Installed node_repl exited before replying (code ${code})`));
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > OUTPUT_LIMIT) {
      this.fail(new Error("Installed node_repl response exceeded 32 MiB"));
      this.child.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("Installed node_repl returned invalid JSON"));
        this.child.kill();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      if (message.error)
        pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
      else if (!Object.hasOwn(message, "result"))
        pending.reject(new Error("MCP response lacks a result"));
      else if (message.result?.resultType && message.result.resultType !== "complete")
        pending.reject(new Error(`Unexpected MCP result type: ${message.result.resultType}`));
      else pending.resolve(message.result);
    }
  }

  notify(method, params) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params: { ...params, _meta: { ...PROTOCOL_META, ...params?._meta } } })}\n`,
    );
  }

  async request(method, params, timeoutMs = 35_000) {
    assert.equal(this.closed, false, "The installed node_repl is already closed");
    const id = this.nextId++;
    return await new Promise((resolvePromise, rejectPromise) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) rejectPromise(error);
        else resolvePromise(result);
      };
      const timer = setTimeout(() => {
        // 截止后只取消本次请求，不能重放可能已送达原生执行器的输入。
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "Acceptance deadline exceeded",
        });
        finish(new Error(`MCP ${method} exceeded its acceptance deadline`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => finish(undefined, result),
        reject: (error) => finish(error),
      });
      try {
        this.child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...PROTOCOL_META, ...params?._meta } } })}\n`,
        );
      } catch (error) {
        finish(error);
      }
    });
  }

  async initialize() {
    // 2026 协议使用 discover 和逐请求 metadata，不能发送旧版 initialize 握手。
    const result = await this.request("server/discover", {});
    assert.ok(
      result.supportedVersions?.includes("2026-07-28"),
      "Unexpected installed MCP protocol",
    );
    return { ...result, protocolVersion: "2026-07-28" };
  }

  async close() {
    if (this.closed) return;
    const exited = once(this.child, "close");
    this.child.stdin.end();
    const deadline = setTimeout(() => this.child.kill(), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
}

export function parseCellResult(result) {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.notEqual(result.isError, true, `Installed SDK call failed: ${text}`);
  const lines = text.split("\n").filter((line) => line.startsWith(RESULT_MARKER));
  assert.equal(lines.length, 1, "Expected exactly one result from the installed SDK");
  return JSON.parse(lines[0].slice(RESULT_MARKER.length));
}

export function requireNativeResult(result, label) {
  const envelope = result?.structuredContent;
  assert.notEqual(result?.isError, true, `${label}: ${JSON.stringify(envelope ?? result)}`);
  assert.equal(envelope?.ok, true, `${label}: native success envelope missing`);
  return envelope.data;
}

export function findFixtureInput(data, title) {
  assert.equal(data?.window?.title, title, "Snapshot targeted a different window");
  assert.notEqual(data.complete, false, "Fixture snapshot was incomplete");
  const matches = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.role === "textfield" && node.name === "MiloCode CUA test input") matches.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(data.tree);
  assert.equal(matches.length, 1, "Fixture text input must be uniquely identified");
  assert.match(
    matches[0].ref_id ?? "",
    /^@[A-Za-z0-9_-]+:e\d+$/u,
    "Input must carry a real qualified snapshot ref",
  );
  return matches[0];
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    assert.ok(
      ["--application", "--work-root", "--fixture-app", "--echo-path"].includes(name),
      `Unknown argument: ${name}`,
    );
    assert.ok(
      argv[index + 1] && !Object.hasOwn(values, name),
      `Missing or duplicate argument: ${name}`,
    );
    values[name] = argv[index + 1];
  }
  for (const name of ["--application", "--work-root", "--fixture-app", "--echo-path"])
    assert.ok(values[name], `Missing ${name}`);
  return values;
}

export async function runWindowsComputerUseAcceptance(argv = process.argv.slice(2)) {
  assert.equal(process.platform, "win32", "Real Computer Use acceptance must run on Windows");
  const args = parseArguments(argv);
  const application = resolve(args["--application"]);
  const workRoot = resolve(args["--work-root"]);
  const fixtureApp = args["--fixture-app"];
  const echoPath = resolve(args["--echo-path"]);
  assert.match(
    fixtureApp,
    /^MiloCodeCuaFixture-[a-f0-9]{12}$/u,
    "Only the self-created fixture may be controlled",
  );
  assert.equal(
    basename(application),
    "MiloCode.exe",
    "Use the installed final MiloCode executable",
  );
  assert.ok(
    process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP),
    "RUNNER_TEMP must be absolute",
  );
  const inside = (parent, child) => {
    const path = relative(resolve(parent), child);
    return path !== "" && !path.startsWith("..") && !isAbsolute(path);
  };
  assert.ok(
    inside(process.env.RUNNER_TEMP, workRoot),
    "Acceptance work root must remain inside RUNNER_TEMP",
  );
  assert.ok(inside(workRoot, echoPath), "Fixture echo must remain inside its own work root");
  const resources = join(dirname(application), "resources");
  const bundle = join(resources, "glm", "packages", "node-repl-host", "dist", "mcp", "server.js");
  const sdk = join(
    resources,
    "glm",
    "packages",
    "zcode-cua-plugin",
    "scripts",
    "computer-use-client.mjs",
  );
  const binary = join(resources, "agent-desktop", "agent-desktop.exe");
  for (const path of [application, bundle, sdk, binary])
    assert.equal((await stat(path)).isFile(), true, `Installed resource missing: ${path}`);
  const nativeState = join(workRoot, "native-state");
  const client = new AcceptanceMcpClient(application, [bundle], {
    cwd: workRoot,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ZCODE_CUA_NODE_REPL_HOST: "1",
      MILOCODE_AGENT_DESKTOP_BINARY: binary,
      MILOCODE_AGENT_DESKTOP_STATE_DIR: nativeState,
      ZCODE_CUA_PLUGIN_ROOT: dirname(dirname(sdk)),
    },
  });
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    fixtureApp,
    scope:
      "Final installed Node REPL → token broker → installed SDK → bundled Windows agent-desktop; self-created fixture only",
    application,
    bundle,
    sdk,
    binary,
    stages: [],
  };
  const reportPath = join(workRoot, "computer-use-result.json");
  const save = async () => await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const record = async (name, details) => {
    report.stages.push({ name, at: new Date().toISOString(), details });
    await save();
  };
  const bootstrap = `const {setupComputerUseRuntime}=await import(${JSON.stringify(pathToFileURL(sdk).href)}); await setupComputerUseRuntime({globals:globalThis}); const desktop=agent.computerUse.desktop;`;
  const cell = async (expression) => {
    const result = await client.request("tools/call", {
      name: "js",
      arguments: {
        code: `${bootstrap}\nconst result=await (${expression}); nodeRepl.write(${JSON.stringify(RESULT_MARKER)}+JSON.stringify(result));`,
        timeout_ms: 30_000,
      },
      _meta: {
        "com.zcode/request-context": {
          runtime_scope: "main",
          session_id: fixtureApp,
          turn_id: "computer-use-acceptance",
          workspace_key: workRoot,
          workspace_path: workRoot,
          client_mode: "desktop-continuous",
          delivery_kind: "desktop-continuous",
        },
      },
    });
    return parseCellResult(result);
  };
  const desktopCall = async (name, input, headed = false) =>
    await cell(`desktop.call(${JSON.stringify(name)},${JSON.stringify(input)},{headed:${headed}})`);
  let stopped = false;
  try {
    await save();
    const initialized = await client.initialize();
    await record("installed-mcp-handshake", { protocol: initialized.protocolVersion });
    const tools = await cell("desktop.tools()");
    const names = tools.structuredContent?.tools?.map((tool) => tool.name) ?? [];
    for (const name of ["desktop_snapshot", "desktop_focus", "desktop_type", "desktop_permissions"])
      assert.ok(names.includes(name), `Required native tool missing: ${name}`);
    assert.equal(
      names.some((name) => /sandbox|exec|session|upgrade/u.test(name)),
      false,
      "Unexpected privileged native tool exposed",
    );
    await record("installed-tools-discovered", { count: names.length, names });
    const permissions = requireNativeResult(
      await desktopCall("desktop_permissions", {}),
      "permissions",
    );
    await record("native-permissions", permissions);
    const before = requireNativeResult(
      await desktopCall("desktop_snapshot", { app: fixtureApp, max_depth: 10 }),
      "before snapshot",
    );
    const input = findFixtureInput(before, fixtureApp);
    await record("fixture-observed", { window: before.window, input });
    requireNativeResult(
      await desktopCall("desktop_focus", { ref_id: input.ref_id }, true),
      "focus fixture input",
    );
    const expected = `MiloCode 中文 😀 ${fixtureApp.slice(-12)}`;
    // 只提交一次；不因超时或未知回执改用其他输入方式，以免掩盖重复执行。
    const typed = requireNativeResult(
      await desktopCall("desktop_type", { ref_id: input.ref_id, text: expected }, true),
      "type into fixture",
    );
    await record("fixture-input-delivered", typed);
    const after = requireNativeResult(
      await desktopCall("desktop_snapshot", { app: fixtureApp, max_depth: 10 }),
      "after snapshot",
    );
    const observed = findFixtureInput(after, fixtureApp);
    assert.equal(
      observed.value,
      expected,
      "Native observation did not confirm the entered Chinese/emoji text",
    );
    const echo = await readFile(echoPath, "utf8");
    assert.equal(echo, expected, "Independent fixture echo did not confirm the same text");
    await record("fixture-effect-verified", {
      window: after.window,
      input: observed,
      independentEcho: echo,
    });
    const stop = await cell("desktop.stop()");
    assert.equal(stop.structuredContent?.stopped, true, "Desktop session did not stop");
    stopped = true;
    const remaining = await readdir(join(nativeState, "runtime"));
    assert.equal(remaining.length, 0, "Stopped native session refs remain");
    await record("native-session-stopped", { remainingRefNamespaces: remaining.length });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    report.errorStack = error instanceof Error ? error.stack : undefined;
    throw error;
  } finally {
    if (!stopped && !client.closed) {
      try {
        await cell("desktop.stop()");
      } catch (error) {
        report.stopError = error instanceof Error ? error.message : String(error);
      }
    }
    await client.close();
    report.nodeReplExitCode = client.exitCode;
    if (client.stderr) report.nodeReplStderr = client.stderr;
    if (report.status === "passed" && (client.exitCode !== 0 || client.stderr)) {
      report.status = "failed";
      report.error = "Installed node_repl did not exit cleanly";
    }
    report.finishedAt = new Date().toISOString();
    await save();
  }
  assert.equal(report.status, "passed", report.error);
  process.stdout.write(`Windows Computer Use final-package acceptance passed: ${reportPath}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runWindowsComputerUseAcceptance().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
