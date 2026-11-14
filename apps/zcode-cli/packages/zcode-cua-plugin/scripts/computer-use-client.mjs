import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class ComputerUseError extends Error {
  constructor(message, { code, possiblySent, actionSent, dispatchStatus, result, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ComputerUseError";
    this.code = code ?? "INTERNAL";
    this.possibly_sent = possiblySent === true || dispatchStatus === "possibly_sent";
    this.actionSent = actionSent === true || this.possibly_sent;
    this.dispatchStatus = dispatchStatus;
    // 保留原始结果，调用方可以展示真实 provider 的错误，不能靠猜测恢复或重放动作。
    this.result = result;
  }
}

function errorDetails(result) {
  const sources = [result?.structuredContent, result];
  const texts = [];
  for (const block of result?.content ?? []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    texts.push(block.text);
    try {
      sources.push(JSON.parse(block.text));
    } catch {
      // 原生工具也会返回纯文本错误；原样保留作用户可见的诊断。
    }
  }
  const details = {};
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const record of [source, source.error, source.action_outcome]) {
      if (!isRecord(record)) continue;
      for (const key of ["code", "message", "possibly_sent", "action_sent", "dispatch_status"]) {
        // 不允许较外层的 false/not_sent 隐藏原生动作结果的不确定性。
        if (
          details[key] === undefined ||
          ((key === "possibly_sent" || key === "action_sent") && record[key] === true) ||
          (key === "dispatch_status" && record[key] === "possibly_sent")
        ) {
          if (record[key] !== undefined) details[key] = record[key];
        }
      }
    }
  }
  if (typeof details.message !== "string") details.message = texts.join("\n");
  return details;
}

function assertOk(method, result) {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new ComputerUseError(`${method} returned an invalid MCP result`, { result });
  }
  const details = errorDetails(result);
  if (
    result.isError !== true &&
    details.possibly_sent !== true &&
    details.dispatch_status !== "possibly_sent"
  ) {
    return result;
  }
  throw new ComputerUseError(details.message || `${method} failed`, {
    code: typeof details.code === "string" ? details.code : "INTERNAL",
    possiblySent: details.possibly_sent,
    actionSent: details.action_sent,
    dispatchStatus: details.dispatch_status,
    result,
  });
}

/**
 * Public bootstrap stays compatible with the injected node_repl bridge. The local runtime owns
 * provider sessions and refs; this facade only forwards the three bounded capabilities.
 */
export async function setupComputerUseRuntime({ globals }) {
  const bridge = globals[BRIDGE_SYMBOL];
  if (!isRecord(bridge) || typeof bridge.call !== "function") {
    throw new ComputerUseError(
      "Computer Use runtime bridge is unavailable. Use Computer Use from a local MiloCode desktop session.",
      { code: "UNAVAILABLE" },
    );
  }
  bridge.assertAvailable?.();

  const call = async (method, args) => {
    let result;
    try {
      bridge.assertAvailable?.();
      // 旧 SDK 自动重试 Helper 冷启动并模拟 AX/frame 协议；新 provider 的原始 schema 与 refs
      // 才是事实来源。所有调用只提交一次，取消或可能已发送后的恢复由重新观察决定。
      result = await bridge.call(method, args);
    } catch (error) {
      if (error instanceof ComputerUseError) throw error;
      throw new ComputerUseError(error instanceof Error ? error.message : String(error), {
        code: typeof error?.code === "string" ? error.code : "INTERNAL",
        possiblySent: error?.possibly_sent,
        actionSent: error?.actionSent ?? error?.action_sent,
        dispatchStatus: error?.dispatchStatus ?? error?.dispatch_status,
        result: error?.result,
        cause: error,
      });
    }
    return assertOk(method, result);
  };

  const desktop = Object.freeze({
    async tools() {
      return await call("desktop_tools", {});
    },
    async call(name, args = {}, options = {}) {
      if (typeof name !== "string" || !name.trim() || !isRecord(args) || !isRecord(options)) {
        throw new ComputerUseError(
          "desktop.call requires a tool name, an arguments object and an options object",
          {
            code: "INVALID_ARGUMENTS",
          },
        );
      }
      if (options.headed !== undefined && typeof options.headed !== "boolean") {
        throw new ComputerUseError("desktop.call headed must be a boolean", {
          code: "INVALID_ARGUMENTS",
        });
      }
      return await call("desktop_call", { name, arguments: args, headed: options.headed ?? false });
    },
    async stop() {
      return await call("desktop_stop", {});
    },
    async emit(result) {
      if (!isRecord(result) || !Array.isArray(result.content)) {
        throw new ComputerUseError("desktop.emit requires an MCP result", {
          code: "INVALID_ARGUMENTS",
        });
      }
      // 显式显示原始 content，不自动发图，也不把截图压成普通文本或重复输出整份参考文档。
      for (const block of result.content) {
        if (
          block?.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          if (typeof globals.nodeRepl?.emitImage !== "function") {
            throw new ComputerUseError("nodeRepl.emitImage is unavailable", {
              code: "UNAVAILABLE",
              result,
            });
          }
          await globals.nodeRepl.emitImage({ base64: block.data, mimeType: block.mimeType });
        } else {
          if (typeof globals.nodeRepl?.write !== "function") {
            throw new ComputerUseError("nodeRepl.write is unavailable", {
              code: "UNAVAILABLE",
              result,
            });
          }
          globals.nodeRepl.write(
            block?.type === "text" && typeof block.text === "string"
              ? block.text
              : JSON.stringify(block),
          );
        }
      }
      if (result.content.length === 0 && result.structuredContent !== undefined) {
        if (typeof globals.nodeRepl?.write !== "function") {
          throw new ComputerUseError("nodeRepl.write is unavailable", {
            code: "UNAVAILABLE",
            result,
          });
        }
        globals.nodeRepl.write(JSON.stringify(result.structuredContent));
      }
    },
  });

  const computerUse = Object.freeze({ desktop });
  const agent = (globals.agent ??= {});
  agent.computerUse = computerUse;

  const previousDocumentation = agent.documentation;
  const previousGet =
    previousDocumentation && typeof previousDocumentation.get === "function"
      ? previousDocumentation.get.bind(previousDocumentation)
      : undefined;
  agent.documentation = Object.freeze({
    get: async (name) => {
      // Browser Use 文档仍由它自己的 loader 负责，不能被桌面控制覆盖。
      if (name !== "computer-use") {
        if (previousGet) return await previousGet(name);
        throw new Error(`Unknown documentation entry: ${name}`);
      }
      if (typeof bridge.documentationRoot !== "string") {
        throw new Error("Computer Use documentation is unavailable");
      }
      return await readFile(join(bridge.documentationRoot, "computer-use.md"), "utf8");
    },
  });

  return computerUse;
}
