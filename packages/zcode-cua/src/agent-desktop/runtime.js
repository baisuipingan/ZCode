import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  DesktopRuntimeError,
  NativeMcpClient,
  nativeEnvironment,
  runNativeCommand,
  terminateChild,
} from "./process.js";

const SAFE_TOOLS = new Set([
  "desktop_snapshot",
  "desktop_find",
  "desktop_screenshot",
  "desktop_get",
  "desktop_is",
  "desktop_click",
  "desktop_double_click",
  "desktop_triple_click",
  "desktop_right_click",
  "desktop_type",
  "desktop_set_value",
  "desktop_clear",
  "desktop_focus",
  "desktop_select",
  "desktop_toggle",
  "desktop_check",
  "desktop_uncheck",
  "desktop_expand",
  "desktop_collapse",
  "desktop_scroll",
  "desktop_scroll_to",
  "desktop_press",
  "desktop_hover",
  "desktop_drag",
  "desktop_mouse_move",
  "desktop_mouse_click",
  "desktop_mouse_wheel",
  "desktop_launch",
  "desktop_list_windows",
  "desktop_list_displays",
  "desktop_list_apps",
  "desktop_focus_window",
  "desktop_resize_window",
  "desktop_move_window",
  "desktop_minimize",
  "desktop_maximize",
  "desktop_restore",
  "desktop_list_surfaces",
  "desktop_wait",
  "desktop_status",
  "desktop_permissions",
]);
const DENIED_ARGUMENTS = new Set([
  "output_path",
  "path",
  "output",
  "headed",
  "session",
  "agent_id",
  "trace",
  "trace_strict",
  "screenshot",
  "request",
  "guide",
  "force",
  "args",
  "env",
  "cwd",
  "cdp",
  "no_attach",
]);
const validator = new AjvJsonSchemaValidator();
const SESSION_IDLE_MS = 10 * 60_000;
const MAX_INACTIVE_SESSIONS = 16;
const READ_ONLY_TOOLS = new Set([
  "desktop_snapshot",
  "desktop_find",
  "desktop_screenshot",
  "desktop_get",
  "desktop_is",
  "desktop_list_windows",
  "desktop_list_displays",
  "desktop_list_apps",
  "desktop_list_surfaces",
  "desktop_wait",
  "desktop_status",
  "desktop_permissions",
]);

function runtimeError(code, message, disposition = "not_sent") {
  return new DesktopRuntimeError(code, message, disposition);
}

function errorResult(error, sent = false) {
  const possiblySent = sent;
  const details = {
    provider: "agent-desktop",
    code: error.code || "native_error",
    message: error.message || "Desktop request failed.",
    disposition: possiblySent ? "possibly_sent" : "not_sent",
    possibly_sent: possiblySent,
    dispatch_status: possiblySent ? "possibly_sent" : "not_sent",
    retryable: false,
    ...(error.nativeError ? { nativeError: error.nativeError } : {}),
  };
  return {
    content: [{ type: "text", text: details.message }],
    isError: true,
    structuredContent: { error: details },
  };
}

function nativeResultWithReceipt(result, toolName) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    throw runtimeError(
      "invalid_response",
      "Native MCP returned an invalid tool result.",
    );
  }
  const envelope = result?.structuredContent;
  if (!result?.isError && envelope?.ok !== false) return result;
  const nativeError =
    envelope?.error && typeof envelope.error === "object" ? envelope.error : {};
  const nativeDisposition =
    nativeError.disposition || nativeError.details?.disposition;
  const disposition =
    typeof nativeDisposition === "object"
      ? nativeDisposition?.delivery
      : nativeDisposition;
  const explicitlySent =
    nativeError.possibly_sent === true ||
    nativeError.action_sent === true ||
    nativeError.dispatch_status === "possibly_sent" ||
    disposition === "delivered";
  const explicitlyUnsent =
    !explicitlySent &&
    (nativeError.possibly_sent === false ||
      nativeError.action_sent === false ||
      disposition === "not_delivered" ||
      nativeError.dispatch_status === "not_sent");
  const possiblySent =
    explicitlySent || (!explicitlyUnsent && !READ_ONLY_TOOLS.has(toolName));
  return {
    ...result,
    isError: true,
    structuredContent: {
      ...envelope,
      error: {
        code: "native_error",
        message:
          result.content.find((item) => item.type === "text")?.text ||
          "Native desktop request failed.",
        ...nativeError,
        possibly_sent: possiblySent,
        dispatch_status: possiblySent ? "possibly_sent" : "not_sent",
      },
    },
  };
}

function stateRootFor(env) {
  const configured = env.MILOCODE_AGENT_DESKTOP_STATE_DIR;
  if (configured && !isAbsolute(configured))
    throw runtimeError(
      "invalid_config",
      "Desktop state directory must be absolute.",
    );
  return configured || join(homedir(), ".milocode", "agent-desktop");
}

export function isAgentDesktopConfigured(env = process.env) {
  return (
    (process.platform === "darwin" || process.platform === "win32") &&
    typeof env.MILOCODE_AGENT_DESKTOP_BINARY === "string" &&
    isAbsolute(env.MILOCODE_AGENT_DESKTOP_BINARY)
  );
}

async function binaryFor(env) {
  if (!isAgentDesktopConfigured(env))
    throw runtimeError(
      "unavailable",
      "The agent-desktop resource is unavailable for this platform.",
    );
  const binaryPath = env.MILOCODE_AGENT_DESKTOP_BINARY;
  const resolved = await realpath(binaryPath).catch(() => undefined);
  const info = resolved && (await stat(resolved).catch(() => undefined));
  if (!info?.isFile())
    throw runtimeError(
      "unavailable",
      "The bundled agent-desktop binary is missing.",
    );
  if (process.platform !== "win32") {
    await access(resolved, constants.X_OK).catch(() => {
      throw runtimeError(
        "unavailable",
        "The bundled agent-desktop binary is not executable.",
      );
    });
  }
  return resolved;
}

function lockPortFor(env) {
  const explicit = env.MILOCODE_AGENT_DESKTOP_LOCK_PORT;
  if (explicit !== undefined) {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw runtimeError("invalid_config", "Invalid desktop lock port.");
    return port;
  }
  const user = `${homedir()}:${process.getuid?.() ?? process.env.USERNAME ?? "current-user"}`;
  return (
    40_000 +
    (createHash("sha256").update(user).digest().readUInt32BE(0) % 20_000)
  );
}

async function acquireDesktopLease(env) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        runtimeError(
          error.code === "EADDRINUSE" ? "busy" : "lock_unavailable",
          error.code === "EADDRINUSE"
            ? "Desktop control is busy in another call or MiloCode process."
            : "Unable to acquire the desktop control lock.",
        ),
      ),
    );
    server.listen(
      { host: "127.0.0.1", port: lockPortFor(env), exclusive: true },
      resolve,
    );
  });
  return async () => await new Promise((resolve) => server.close(resolve));
}

function validateContext(context, options) {
  if (
    !context ||
    context.runtimeScope !== "main" ||
    !context.sessionId ||
    !context.workspaceKey
  ) {
    throw runtimeError(
      "not_authorized",
      "Desktop control requires a trusted main-agent session.",
    );
  }
  const identity = context.workspaceIdentity?.trim();
  if (
    context.remoteSessionId ||
    (identity &&
      (!options.isRemoteWorkspaceIdentity ||
        options.isRemoteWorkspaceIdentity(identity)))
  ) {
    throw runtimeError(
      "remote_not_supported",
      "Desktop control is available only in a local workspace.",
    );
  }
  if (
    [context.clientMode, context.deliveryKind].some(
      (mode) => mode !== undefined && mode !== "desktop-continuous",
    )
  ) {
    throw runtimeError(
      "remote_not_supported",
      "Desktop control is unavailable through replayable remote delivery.",
    );
  }
  return JSON.stringify([context.sessionId, identity || context.workspaceKey]);
}

function filteredTool(tool) {
  if (
    !SAFE_TOOLS.has(tool.name) ||
    !tool.inputSchema ||
    tool.inputSchema.type !== "object"
  )
    return undefined;
  const schema = structuredClone(tool.inputSchema);
  if ((schema.required || []).some((key) => DENIED_ARGUMENTS.has(key)))
    return undefined;
  schema.additionalProperties = false;
  for (const key of Object.keys(schema.properties || {})) {
    if (DENIED_ARGUMENTS.has(key)) delete schema.properties[key];
  }
  if (tool.name === "desktop_launch" && schema.properties?.app) {
    schema.properties.app = {
      ...schema.properties.app,
      pattern: "^[^/\\\\\\u0000-\\u001f]{1,256}$",
    };
  }
  return { ...tool, inputSchema: schema };
}

async function loadTools(client, signal) {
  const result = await client.request(
    "tools/list",
    {},
    { signal, timeoutMs: 10_000 },
  );
  if (!Array.isArray(result?.tools))
    throw runtimeError(
      "invalid_response",
      "Native MCP returned an invalid tool list.",
    );
  const tools = result.tools.map(filteredTool).filter(Boolean);
  const validators = new Map(
    tools.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)]),
  );
  return { tools, validators };
}

function checkCall(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["name", "arguments", "headed"].includes(key),
    ) ||
    typeof input.name !== "string" ||
    !SAFE_TOOLS.has(input.name) ||
    (input.headed !== undefined && typeof input.headed !== "boolean")
  ) {
    throw runtimeError(
      "invalid_arguments",
      "Use an allowed desktop tool name, arguments object, and optional headed boolean.",
    );
  }
  const args = input.arguments ?? {};
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    JSON.stringify(args).length > 256 * 1024
  ) {
    throw runtimeError(
      "invalid_arguments",
      "Desktop tool arguments must be a bounded JSON object.",
    );
  }
  if (
    input.name === "desktop_launch" &&
    args.activate &&
    input.headed !== true
  ) {
    throw runtimeError(
      "foreground_required",
      "Launching an app in the foreground requires headed: true.",
    );
  }
  return args;
}

export async function getAgentDesktopPermissionStatus(env = process.env) {
  env = { ...process.env, ...env };
  let client;
  const children = new Set();
  const binaryPath = env.MILOCODE_AGENT_DESKTOP_BINARY;
  const metadata = {
    provider: "agent-desktop",
    ...(binaryPath ? { binaryPath } : {}),
  };
  try {
    const binary = await binaryFor(env);
    client = new NativeMcpClient(
      binary,
      [],
      nativeEnvironment(env, stateRootFor(env)),
      children,
    );
    await client.initialize();
    const result = await client.request(
      "tools/call",
      { name: "desktop_permissions", arguments: { request: false } },
      { timeoutMs: 8_000 },
    );
    const envelope = result?.structuredContent;
    if (result?.isError || envelope?.ok === false || !envelope?.data)
      throw runtimeError(
        "permission_query_failed",
        "Unable to read native desktop permissions.",
      );
    const data = envelope.data;
    const state = (value) =>
      value?.state === "granted" || value?.state === "not_required"
        ? "granted"
        : value?.state === "denied"
          ? "denied"
          : "unknown";
    return {
      ...metadata,
      available: true,
      platform: process.platform,
      grantOwner: null,
      grantOwnerDisplayName: "agent-desktop",
      owner: null,
      accessibility: state(data.accessibility),
      screenRecording: state(data.screen_recording),
      // The native permission report reads TCC/UIA state; it does not functionally inspect
      // a target or capture a frame. Do not present a grant as a completed operation probe.
      accessibilityProbeOk: false,
      screenCaptureProbeOk: false,
    };
  } catch (error) {
    return {
      ...metadata,
      available: false,
      reason: error.message || "Desktop permission status is unavailable.",
    };
  } finally {
    await client?.close();
    await Promise.all([...children].map((child) => terminateChild(child, env)));
  }
}

export function createAgentDesktopRuntime(options = {}) {
  const env = { ...process.env, ...options.env };
  const sessions = new Map();
  let disposed = false;
  let active = false;
  let activeKey;
  let activeDone;
  let finishActive;
  let activeController;

  const cleanup = async (key, state) => {
    if (state.cleaning) return await state.cleaning;
    state.controller.abort();
    state.cleaning = (async () => {
      const children = new Set([
        ...state.children,
        ...[...state.clients.values()].map((client) => client.child),
      ]);
      await Promise.all(
        [...children].map((child) => terminateChild(child, state.env || env)),
      );
      // stop 可能与异步资源检查或 session 创建重叠。先等初始化结束再删私有目录，
      // 避免迟到的 mkdir 重新留下无人管理的 refs。
      await state.setup?.catch(() => {});
      for (const client of state.clients.values())
        client.fail("Desktop control was stopped.");
      await rm(state.root, { recursive: true, force: true });
      if (sessions.get(key) === state) sessions.delete(key);
    })();
    return await state.cleaning;
  };

  const getState = async (key, signal) => {
    let state = sessions.get(key);
    if (state) {
      state.inFlight = true;
      return state;
    }
    if (disposed || signal?.aborted)
      throw runtimeError("cancelled", "Desktop control was stopped.");
    state = {
      key,
      controller: new AbortController(),
      children: new Set(),
      clients: new Map(),
      root: join(stateRootFor(env), "runtime", randomUUID()),
      inFlight: true,
      lastUsed: Date.now(),
    };
    sessions.set(key, state);
    const joinedSignal = AbortSignal.any([
      state.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    state.setup = (async () => {
      state.binary = await binaryFor(env);
      if (joinedSignal.aborted)
        throw runtimeError("cancelled", "Desktop control was stopped.");
      await mkdir(state.root, { recursive: true, mode: 0o700 });
      state.env = nativeEnvironment(env, state.root);
      const result = await runNativeCommand(
        state.binary,
        ["session", "start", "--no-trace", "--name", "MiloCode"],
        state.env,
        state.children,
        joinedSignal,
      );
      const id = result?.data?.session_id;
      if (
        result?.ok !== true ||
        typeof id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(id)
      ) {
        throw runtimeError(
          "invalid_response",
          "Native session setup returned an invalid session ID.",
        );
      }
      state.nativeId = id;
      if (joinedSignal.aborted || disposed)
        throw runtimeError("cancelled", "Desktop control was stopped.");
    })();
    await state.setup;
    return state;
  };

  const getClient = async (state, headed, signal) => {
    if (signal.aborted)
      throw runtimeError("cancelled", "Desktop control was stopped.");
    const key = headed ? "headed" : "background";
    let client = state.clients.get(key);
    if (!client) {
      client = new NativeMcpClient(
        state.binary,
        ["--session", state.nativeId, ...(headed ? ["--headed"] : [])],
        state.env,
        state.children,
      );
      client.onExit = () => {
        void cleanup(state.key, state);
      };
      state.clients.set(key, client);
      await client.initialize(signal);
    }
    return client;
  };

  const pruneIdleSessions = async () => {
    const idle = [...sessions]
      .filter(([, state]) => !state.inFlight)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const overflow = Math.max(0, idle.length - MAX_INACTIVE_SESSIONS);
    await Promise.all(
      idle
        .filter(
          ([, state], index) =>
            index < overflow || Date.now() - state.lastUsed >= SESSION_IDLE_MS,
        )
        .map(([key, state]) => cleanup(key, state)),
    );
  };
  // This only removes inactive refs. It never submits or retries a desktop command.
  const gcTimer = setInterval(() => {
    void pruneIdleSessions().catch(() => {});
  }, 60_000);
  gcTimer.unref();

  return {
    async execute(input) {
      let key;
      let state;
      let release;
      let sent = false;
      let ownedActive = false;
      let client;
      try {
        if (disposed)
          throw runtimeError(
            "unavailable",
            "Desktop runtime has been disposed.",
          );
        if (env.ZCODE_CUA_NODE_REPL_HOST !== "1")
          throw runtimeError(
            "not_authorized",
            "Desktop runtime requires the trusted local Node REPL host.",
          );
        key = validateContext(input.context, options);
        if (
          !["desktop_tools", "desktop_call", "desktop_stop"].includes(
            input.toolName,
          )
        )
          throw runtimeError(
            "invalid_arguments",
            "Unsupported desktop runtime method.",
          );
        if (input.toolName === "desktop_stop") {
          if (activeKey === key) activeController?.abort();
          state = sessions.get(key);
          if (state) await cleanup(key, state);
          if (activeKey === key) await activeDone;
          return {
            content: [
              {
                type: "text",
                text: "Desktop control stopped; previous refs are no longer valid.",
              },
            ],
            structuredContent: { stopped: true },
          };
        }
        const args =
          input.toolName === "desktop_call"
            ? checkCall(input.arguments)
            : undefined;
        if (input.signal?.aborted)
          throw runtimeError("cancelled", "Desktop request cancelled.");
        if (active)
          throw runtimeError(
            "busy",
            "Desktop control is busy in another call.",
          );
        active = true;
        activeKey = key;
        activeDone = new Promise((resolve) => {
          finishActive = resolve;
        });
        activeController = new AbortController();
        ownedActive = true;
        release = await acquireDesktopLease(env);
        await pruneIdleSessions();
        const callSignal = AbortSignal.any([
          activeController.signal,
          ...(input.signal ? [input.signal] : []),
        ]);
        state = await getState(key, callSignal);
        const signal = AbortSignal.any([state.controller.signal, callSignal]);
        if (state.catalog && input.toolName === "desktop_tools") {
          return {
            content: [
              { type: "text", text: JSON.stringify(state.catalog.tools) },
            ],
            structuredContent: {
              provider: "agent-desktop",
              tools: structuredClone(state.catalog.tools),
            },
          };
        }
        if (state.catalog && input.toolName === "desktop_call") {
          const validation = state.catalog.validators.get(
            input.arguments.name,
          )?.(args);
          if (!validation?.valid)
            throw runtimeError(
              "invalid_arguments",
              validation?.errorMessage ||
                "The native provider does not expose this tool.",
            );
        }
        client = await getClient(
          state,
          input.toolName === "desktop_call" && input.arguments.headed === true,
          signal,
        );
        state.catalog ||= await loadTools(client, signal);
        if (input.toolName === "desktop_tools") {
          return {
            content: [
              { type: "text", text: JSON.stringify(state.catalog.tools) },
            ],
            structuredContent: {
              provider: "agent-desktop",
              tools: structuredClone(state.catalog.tools),
            },
          };
        }
        const validate = state.catalog.validators.get(input.arguments.name);
        const validation = validate?.(args);
        if (!validation?.valid)
          throw runtimeError(
            "invalid_arguments",
            validation?.errorMessage ||
              "The native provider does not expose this tool.",
          );
        const nativeArgs =
          input.arguments.name === "desktop_permissions"
            ? { request: false }
            : args;
        const result = await client.request(
          "tools/call",
          { name: input.arguments.name, arguments: nativeArgs },
          {
            signal,
            onSent: () => {
              sent = true;
            },
          },
        );
        return nativeResultWithReceipt(result, input.arguments.name);
      } catch (error) {
        state ||= key && sessions.get(key);
        if (
          state &&
          !["invalid_arguments", "busy", "foreground_required"].includes(
            error.code,
          )
        )
          await cleanup(key, state);
        return errorResult(error, sent);
      } finally {
        if (client) {
          await client.close();
          if (state) state.clients.clear();
        }
        if (state && ownedActive) {
          state.inFlight = false;
          state.lastUsed = Date.now();
        }
        if (release) await release();
        if (ownedActive) {
          active = false;
          activeKey = undefined;
          finishActive?.();
          finishActive = undefined;
          activeController = undefined;
        }
        if (ownedActive) await pruneIdleSessions();
      }
    },
    async closeSession(context) {
      const key = JSON.stringify([
        context.sessionId,
        context.workspaceIdentity?.trim() || context.workspaceKey,
      ]);
      if (activeKey === key) activeController?.abort();
      const state = sessions.get(key);
      if (state) await cleanup(key, state);
      if (activeKey === key) await activeDone;
    },
    async dispose() {
      disposed = true;
      clearInterval(gcTimer);
      activeController?.abort();
      await Promise.all(
        [...sessions].map(([key, state]) => cleanup(key, state)),
      );
      await activeDone;
    },
  };
}
