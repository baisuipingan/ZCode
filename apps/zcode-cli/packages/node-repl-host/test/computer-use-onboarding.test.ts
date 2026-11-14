import { describe, expect, it, vi } from "vitest";

/**
 * Computer Use 的 SDK 只适配现有 node_repl capability bridge；原生 schema 和 refs 由 runtime 持有。
 * 保留按需文档回归，并验证新 provider 不会被旧私有 Helper 的解包、重试和 AX 模拟污染。
 */
async function makeGlobals(bridgeOverrides: Record<string, unknown> = {}) {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const clientUrl = fileURLToPath(
    new URL("../../zcode-cua-plugin/scripts/computer-use-client.mjs", import.meta.url),
  );
  const documentationRoot = join(dirname(clientUrl), "..", "docs");
  const bridge = {
    call: vi.fn(async (_method: string, _args: Record<string, unknown>) => ({
      content: [{ type: "text", text: "ok" }],
    })),
    assertAvailable: vi.fn(),
    documentationRoot,
    ...bridgeOverrides,
  };
  const browser = { sentinel: "browser-control-stays-independent" };
  const previousDocumentationGet = vi.fn(async (name: string) => `browser reference: ${name}`);
  const nodeRepl = { write: vi.fn(), emitImage: vi.fn() };
  const globals: Record<PropertyKey, unknown> = {
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: bridge,
    agent: { browsers: browser, documentation: { get: previousDocumentationGet } },
    nodeRepl,
  };
  const mod = await import(clientUrl);
  const computerUse = await mod.setupComputerUseRuntime({ globals });
  const agent = globals.agent as {
    computerUse: typeof computerUse;
    browsers: typeof browser;
    documentation: { get: (name: string) => Promise<string> };
  };
  return {
    globals,
    bridge,
    mod,
    computerUse,
    desktop: computerUse.desktop,
    agent,
    browser,
    nodeRepl,
    previousDocumentationGet,
  };
}

describe("computer-use desktop bridge", () => {
  it("returns real tool schemas and call results unchanged without pushing reference or content", async () => {
    const result = {
      content: [
        {
          type: "text",
          text: '{"tools":[{"name":"observed_tool","inputSchema":{"type":"object"}}]}',
        },
      ],
      structuredContent: { tools: [{ name: "observed_tool", inputSchema: { type: "object" } }] },
      _meta: { provider: "fixture-native-provider" },
    };
    const call = vi.fn(async () => result);
    const { desktop, nodeRepl, computerUse, agent } = await makeGlobals({ call });
    expect(await desktop.tools()).toBe(result);
    expect(call).toHaveBeenCalledExactlyOnceWith("desktop_tools", {});
    expect(nodeRepl.write).not.toHaveBeenCalled();
    expect(nodeRepl.emitImage).not.toHaveBeenCalled();
    expect(agent.computerUse).toBe(computerUse);
    expect(Object.keys(computerUse)).toEqual(["desktop"]);
    expect(Object.keys(desktop)).toEqual(["tools", "call", "stop", "emit"]);
  });

  it("forwards native arguments unchanged and uses background unless one call explicitly opts in", async () => {
    const { desktop, bridge } = await makeGlobals();
    const args = { ref: "native-snapshot-ref", text: "原样保留", nested: { mode: "exact" } };
    await desktop.call("discovered_action", args);
    await desktop.call("discovered_action", args, { headed: true });
    await desktop.call("discovered_observation");
    expect(bridge.call).toHaveBeenNthCalledWith(1, "desktop_call", {
      name: "discovered_action",
      arguments: args,
      headed: false,
    });
    expect(bridge.call).toHaveBeenNthCalledWith(2, "desktop_call", {
      name: "discovered_action",
      arguments: args,
      headed: true,
    });
    expect(bridge.call).toHaveBeenNthCalledWith(3, "desktop_call", {
      name: "discovered_observation",
      arguments: {},
      headed: false,
    });
    expect(bridge.call.mock.calls[0]?.[1].arguments).toBe(args);
  });

  it("rejects malformed call envelopes before reaching the runtime", async () => {
    const { desktop, bridge } = await makeGlobals();
    await expect(desktop.call("", {})).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(desktop.call("discovered_tool", [])).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });
    await expect(desktop.call("discovered_tool", {}, { headed: "yes" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("preserves provider errors, raw result and possibly-sent semantics without replay", async () => {
    const result = {
      content: [
        {
          type: "text",
          text: "Cancelled after dispatch; inspect the application before continuing.",
        },
      ],
      structuredContent: {
        code: "CANCELLED",
        possibly_sent: true,
        dispatch_status: "possibly_sent",
      },
      isError: true,
    };
    const call = vi.fn(async () => result);
    const { desktop, mod } = await makeGlobals({ call });
    const error = await desktop
      .call("discovered_action", { ref: "live-ref" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(mod.ComputerUseError);
    expect(error).toMatchObject({
      message: "Cancelled after dispatch; inspect the application before continuing.",
      code: "CANCELLED",
      possibly_sent: true,
      actionSent: true,
      dispatchStatus: "possibly_sent",
      result,
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not interpret a possibly-sent non-error envelope as successful or retry it", async () => {
    const result = {
      structuredContent: { possibly_sent: false, dispatch_status: "not_sent" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "TIMEOUT",
            message: "Action outcome is uncertain",
            action_outcome: { dispatch_status: "possibly_sent" },
          }),
        },
      ],
      isError: false,
    };
    const call = vi.fn(async () => result);
    const { desktop } = await makeGlobals({ call });
    await expect(desktop.call("discovered_action")).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Action outcome is uncertain",
      possibly_sent: true,
      result,
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retains transport diagnostics and checks the bridge availability on each call", async () => {
    const cause = Object.assign(new Error("The controller was stopped after dispatch"), {
      code: "STOPPED",
      possibly_sent: true,
      action_sent: true,
      dispatch_status: "possibly_sent",
    });
    const call = vi.fn(async () => {
      throw cause;
    });
    const assertAvailable = vi.fn();
    const { desktop } = await makeGlobals({ call, assertAvailable });
    await expect(desktop.call("discovered_action")).rejects.toMatchObject({
      code: "STOPPED",
      possibly_sent: true,
      actionSent: true,
      dispatchStatus: "possibly_sent",
      cause,
    });
    expect(call).toHaveBeenCalledTimes(1);
    assertAvailable.mockImplementation(() => {
      throw new Error("Computer Use is not available in subagent");
    });
    await expect(desktop.tools()).rejects.toThrow("Computer Use is not available in subagent");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("forwards stop as a single bounded call", async () => {
    const result = { content: [], structuredContent: { stopped: true } };
    const call = vi.fn(async () => result);
    const { desktop } = await makeGlobals({ call });
    expect(await desktop.stop()).toBe(result);
    expect(call).toHaveBeenCalledExactlyOnceWith("desktop_stop", {});
  });

  it("explicitly emits text and image using node_repl helpers while preserving raw content", async () => {
    const result = {
      content: [
        { type: "text", text: "The application window snapshot" },
        { type: "image", data: "AQIDBA==", mimeType: "image/png" },
        { type: "resource_link", uri: "fixture://snapshot", name: "snapshot" },
      ],
      structuredContent: { providerRef: "snapshot-17" },
    };
    const before = structuredClone(result);
    const { desktop, nodeRepl, bridge } = await makeGlobals();
    await desktop.emit(result);
    expect(nodeRepl.write).toHaveBeenNthCalledWith(1, "The application window snapshot");
    expect(nodeRepl.emitImage).toHaveBeenCalledExactlyOnceWith({
      base64: "AQIDBA==",
      mimeType: "image/png",
    });
    expect(nodeRepl.write).toHaveBeenNthCalledWith(2, JSON.stringify(result.content[2]));
    expect(result).toEqual(before);
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("can display an original error and empty-content structured result without hiding them", async () => {
    const { desktop, nodeRepl } = await makeGlobals();
    await desktop.emit({
      isError: true,
      content: [{ type: "text", text: "Permission denied by the OS" }],
    });
    await desktop.emit({ content: [], structuredContent: { tools: [] } });
    expect(nodeRepl.write).toHaveBeenNthCalledWith(1, "Permission denied by the OS");
    expect(nodeRepl.write).toHaveBeenNthCalledWith(2, '{"tools":[]}');
  });

  it("serves the reference only on demand and preserves Browser Use's namespace and loader", async () => {
    const { agent, browser, previousDocumentationGet, nodeRepl } = await makeGlobals();
    const doc = await agent.documentation.get("computer-use");
    expect(doc).toMatch(/^# Computer Use/u);
    expect(doc).toMatch(/## Tool arguments/u);
    expect(doc).toContain("desktop.tools()");
    expect(agent.browsers).toBe(browser);
    expect(await agent.documentation.get("browser-use")).toBe("browser reference: browser-use");
    expect(previousDocumentationGet).toHaveBeenCalledExactlyOnceWith("browser-use");
    expect(nodeRepl.write).not.toHaveBeenCalled();
  });

  it("reports a missing bridge rather than fabricating the native provider", async () => {
    const { mod } = await makeGlobals();
    await expect(mod.setupComputerUseRuntime({ globals: {} })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
