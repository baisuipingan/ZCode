# Computer Use

MiloCode's desktop skill uses a bundled native desktop provider through the existing `node_repl` host. The provider owns native sessions, snapshot refs, permission checks and cancellation. The SDK only forwards bounded calls and displays results. It does not reproduce the former private Helper's accessibility or frame protocol.

Use this capability only from the main agent in a local macOS or Windows desktop session. Linux, remote workspaces, web sessions and subagents are unavailable. Browser Use remains a separate capability for web pages.

## Bootstrap

Every `mcp__node_repl__js` cell has a fresh Worker. Imports and bindings do not survive the cell; the trusted host retains the provider session and refs across cells while closing the native client after each call. Cancellation, stop, session close and disposal invalidate those refs. Inactive refs expire after ten minutes; at most sixteen inactive sessions are retained, so older refs may be evicted sooner. After a pause or eviction, take a fresh snapshot before acting rather than reusing a previous ref.

```js
const root =
  process.env.ZCODE_CUA_PLUGIN_ROOT ??
  process.env.ZCODE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href
);
await setupComputerUseRuntime({ globals: globalThis });
const desktop = agent.computerUse.desktop;
```

The bootstrap keeps its original `setupComputerUseRuntime({ globals })` signature and installs only the `agent.computerUse` namespace. It does not replace `agent.browsers`; documentation requests other than `"computer-use"` continue through the previous documentation loader.

## API

```typescript
interface Desktop {
  tools(): Promise<McpResult>;
  call(
    name: string,
    arguments?: Record<string, unknown>,
    options?: { headed?: boolean },
  ): Promise<McpResult>;
  stop(): Promise<McpResult>;
  emit(result: McpResult): Promise<void>;
}

interface McpResult {
  content: Array<unknown>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}
```

`tools()`, `call()` and `stop()` return the original successful MCP result. They do not unwrap text JSON, rename fields, create fake semantic refs, hide metadata or automatically display content. Provider errors throw `ComputerUseError` with the original result retained as `error.result`.

### `desktop.tools()`

Fetch the real allowlisted native tool definitions and input schemas. Display them at the start of a desktop task:

```js
await desktop.emit(await desktop.tools());
```

Tools are discovered dynamically from the bundled provider's fixed version. Only the runtime's allowlisted desktop tools are exposed. Do not infer an unavailable tool from upstream documentation or guess aliases. Process execution, downloads, upgrades and model-provider settings are outside this interface.

### `desktop.call(name, arguments, options)`

Submit one allowed tool call with the exact arguments required by its discovered schema. The default arguments object is `{}` and the default is `{ headed: false }`.

```js
const result = await desktop.call(toolName, toolArguments);
await desktop.emit(result);
```

Here `toolName` and `toolArguments` must be filled from the actual `tools()` response and the user's task. They are not literal provider tool names. Runtime schema validation is authoritative; the SDK does not transform arguments to approximate a different API.

Background is the default. Foreground must be explicit for each call:

```js
await desktop.emit(await desktop.call(toolName, toolArguments, { headed: true }));
```

Use foreground only when it is necessary and the user's task permits it. Do not automatically repeat a failed background operation with `headed: true`. Background availability depends on the real operation and platform; this API does not guarantee that every action can run without focus.

### `desktop.emit(result)`

Display an existing MCP result without calling the desktop provider:

- Text content goes to `nodeRepl.write`.
- Image content goes to `nodeRepl.emitImage` with its original base64 and MIME type.
- Other content blocks are shown as JSON rather than silently discarded.
- If the content array is empty, an available `structuredContent` object is shown as JSON.

The result itself remains unchanged. Full documentation is never pushed automatically. Request it when needed with `nodeRepl.write(await agent.documentation.get("computer-use"))`.

### `desktop.stop()`

Stop this trusted session's desktop control and discard its provider refs. The runtime cleans up controlled processes and its lock. Do not resume with refs from before stopping; discover and observe the current desktop state again.

Stop on user request, and do not schedule further desktop actions while stopping. `stop()` does not imply that a previously dispatched action was undone.

## Tool arguments

There is no hardcoded list of native tool parameters in this SDK. `desktop.tools()` supplies the current names, descriptions and input schemas; this reference documents the stable MiloCode bridge only.

Observation results are the source of application/window identity and snapshot refs. Prefer semantic refs that the real snapshot advertises. If a coordinate action is available, use the provider's documented coordinate space for the corresponding screenshot. Do not fabricate old AX element indices or `state_id` / `frame_id` values. The old `getApp`, `getAXState`, `computer.*` and `requestAccess` facades are not present.

After an app or window changes, a stale ref is reported, or a call is cancelled or stopped, observe again before the next action. Never reuse a ref for a different app or window. Verify actual UI effects after actions; API acceptance alone is not proof that a document was saved or a submission completed.

## Errors, cancellation and retries

`ComputerUseError` provides:

```typescript
interface ComputerUseError extends Error {
  code: string;
  possibly_sent: boolean;
  actionSent: boolean;
  dispatchStatus?: string;
  result?: McpResult;
  cause?: unknown;
}
```

The runtime's error code and diagnostic are preserved. When the runtime reports that an action may have been sent, the SDK propagates `possibly_sent` and `actionSent`; it never retries. A result with `dispatch_status: "possibly_sent"` also throws even if its MCP `isError` flag is false. Treat that outcome as uncertain, not as a failure safe to replay.

```js
try {
  await desktop.emit(await desktop.call(toolName, toolArguments));
} catch (error) {
  if (error.result) await desktop.emit(error.result);
  // Keep the failure visible. Do not repeat an action automatically.
  throw error;
}
```

Cancellation terminates controlled work and invalidates that session's refs. It cannot roll back an action already delivered to the application. A timeout or transport failure likewise does not prove no effect occurred. Observe before deciding what remains to do. Busy errors are not queued by this SDK, and it does not start a second provider session to bypass exclusive desktop control.

## Permissions and authorization

The local runtime validates the trusted main-agent session and workspace identity. Model-supplied tool arguments cannot replace that identity. Operating-system permissions apply to the actual bundled execution program, not to an unrelated shell or private Helper.

For permission denial, missing resources or unsupported actions, preserve the diagnostic and ask for the appropriate user action when required. Do not click protected security dialogs, grant permissions, disable system security or route around denial with another automation technology.

Desktop observations may contain personal information. Read only what the user's task needs, and do not export snapshots or screenshots without authorization for that destination. A tool being available does not authorize messages, purchases, deletion or other consequential actions. Browser Use, existing connectors and the user's confirmation requirements remain independent of this desktop capability.
