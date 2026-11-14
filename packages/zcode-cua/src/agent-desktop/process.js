import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_OUTPUT = 64 * 1024 * 1024;
const INITIALIZE_TIMEOUT = 10_000;
const terminations = new WeakMap();

export class DesktopRuntimeError extends Error {
  constructor(code, message, disposition = "not_sent") {
    super(message);
    this.code = code;
    this.disposition = disposition;
  }
}

export function nativeEnvironment(env, stateRoot) {
  const result = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "SystemRoot",
    "SYSTEMDRIVE",
    "HOMEDRIVE",
    "HOMEPATH",
  ]) {
    if (typeof env[key] === "string") result[key] = env[key];
  }
  result.AGENT_DESKTOP_HOME = stateRoot;
  return result;
}

function launch(binaryPath, args, env, children) {
  const child = spawn(binaryPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  // 管道分片可能截断中文或 emoji 的 UTF-8 字节。先增量解码再解析 JSON 行，
  // 避免无障碍文本被静默替换为乱码。
  child.stdout.setEncoding("utf8");
  children.add(child);
  child.once("close", () => children.delete(child));
  // Native diagnostics may contain desktop text. Drain without logging or retaining it.
  child.stderr.on("data", () => {});
  return child;
}

export async function terminateChild(child, env) {
  if (terminations.has(child)) return await terminations.get(child);
  const termination = terminateOwnedChild(child, env);
  terminations.set(child, termination);
  return await termination;
}

async function terminateOwnedChild(child, env) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    if (systemRoot) {
      await new Promise((resolve) => {
        const killer = spawn(
          join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true, shell: false },
        );
        const timeout = setTimeout(() => {
          killer.kill();
          resolve();
        }, 1_500);
        killer.once("error", () => {
          clearTimeout(timeout);
          resolve();
        });
        killer.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    child.kill("SIGKILL");
    return;
  }
  // MCP 每次工具调用会派生原生 worker；只杀 server 会留下尚未执行的输入。
  // 独立 POSIX 进程组只包含本 runtime 创建的子进程，因此可以整体终止。
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

export async function runNativeCommand(
  binaryPath,
  args,
  env,
  children,
  signal,
) {
  if (signal?.aborted)
    throw new DesktopRuntimeError("cancelled", "Desktop request cancelled.");
  const child = launch(binaryPath, args, env, children);
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      void terminateChild(child, env);
      finish(
        new DesktopRuntimeError("cancelled", "Desktop request cancelled."),
      );
    };
    const timeout = setTimeout(() => {
      void terminateChild(child, env);
      finish(
        new DesktopRuntimeError("timeout", "Desktop initialization timed out."),
      );
    }, INITIALIZE_TIMEOUT);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) {
        void terminateChild(child, env);
        finish(
          new DesktopRuntimeError(
            "invalid_response",
            "Native command output exceeded its limit.",
          ),
        );
      }
    });
    child.once("error", () =>
      finish(
        new DesktopRuntimeError(
          "unavailable",
          "Unable to launch agent-desktop.",
        ),
      ),
    );
    child.once("close", (code) => {
      if (code !== 0)
        return finish(
          new DesktopRuntimeError(
            "native_exit",
            "Native session setup failed.",
          ),
        );
      try {
        finish(undefined, JSON.parse(output.trim()));
      } catch {
        finish(
          new DesktopRuntimeError(
            "invalid_response",
            "Invalid native session response.",
          ),
        );
      }
    });
    if (signal?.aborted) abort();
  });
}

export class NativeMcpClient {
  constructor(binaryPath, args, env, children) {
    this.child = launch(binaryPath, ["mcp", ...args], env, children);
    this.env = env;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.closed = false;
    this.child.stdout.on("data", (chunk) => this.read(chunk));
    this.child.stdin.on("error", () => this.fail("Native MCP input closed."));
    this.child.once("error", () =>
      this.fail("Unable to launch native MCP server."),
    );
    this.child.once("close", () => {
      this.fail("Native MCP server exited.");
      if (!this.intentionalClose) this.onExit?.();
    });
  }

  fail(message) {
    this.closed = true;
    for (const request of this.pending.values()) {
      request.reject(
        new DesktopRuntimeError(
          "native_exit",
          message,
          request.sent ? "possibly_sent" : "not_sent",
        ),
      );
    }
    this.pending.clear();
  }

  read(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_OUTPUT) {
      this.fail("Native MCP output exceeded its limit.");
      void terminateChild(this.child, this.env);
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
        this.fail("Invalid native MCP response.");
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new DesktopRuntimeError(
          "native_rpc_error",
          message.error.message || "Native MCP request failed.",
          request.sent ? "possibly_sent" : "not_sent",
        );
        error.nativeError = message.error;
        request.reject(error);
      } else request.resolve(message.result);
    }
  }

  async initialize(signal) {
    await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "MiloCode", version: "1.0.0" },
      },
      { signal, timeoutMs: INITIALIZE_TIMEOUT },
    );
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  send(message) {
    if (this.closed)
      throw new DesktopRuntimeError(
        "native_exit",
        "Native MCP server is closed.",
      );
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, { signal, timeoutMs = 60_000, onSent } = {}) {
    if (signal?.aborted)
      return Promise.reject(
        new DesktopRuntimeError("cancelled", "Desktop request cancelled."),
      );
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const complete = (error, value) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        try {
          this.send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: "MiloCode request cancelled" },
          });
        } catch {}
        complete(
          new DesktopRuntimeError(
            "cancelled",
            "Desktop request cancelled.",
            pending.sent ? "possibly_sent" : "not_sent",
          ),
        );
      };
      const timeout = setTimeout(() => {
        complete(
          new DesktopRuntimeError(
            "timeout",
            "Desktop request exceeded its deadline.",
            pending.sent ? "possibly_sent" : "not_sent",
          ),
        );
      }, timeoutMs);
      const pending = {
        sent: false,
        resolve: (value) => complete(undefined, value),
        reject: (error) => complete(error),
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        pending.sent = true;
        this.send({ jsonrpc: "2.0", id, method, params });
        onSent?.();
      } catch (error) {
        complete(error);
      }
      if (signal?.aborted) abort();
    });
  }

  async close() {
    this.intentionalClose = true;
    this.fail("Desktop control was stopped.");
    await terminateChild(this.child, this.env);
  }
}
