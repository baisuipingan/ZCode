---
name: computer-use
description: "Use the local MiloCode desktop's native apps and OS through the bundled desktop provider. Main agent only. Use Browser Use for web pages."
---

# Computer Use

Use this skill for the UI of native desktop apps and the operating system. Prefer an existing connector, API or CLI when it completes the task. Use Browser Use for content inside a web page.

This provider runs on the user's local macOS or Windows desktop. It is unavailable to subagents, remote workspaces, Linux and web sessions. Do not delegate desktop control to another agent or attempt to control a remote machine through this skill.

## Bootstrap every call

Each `mcp__node_repl__js` cell runs in a fresh Worker. Recreate the SDK binding in each cell; the trusted host keeps the provider session and snapshot refs across cells without keeping the native client running. Inactive refs expire after ten minutes, and only sixteen inactive sessions are retained. Older refs may be evicted sooner. After a pause or eviction, take a fresh snapshot before the next action.

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

## Discover before acting

At the start of a desktop task, display the available native tools and their real argument schemas:

```js
await desktop.emit(await desktop.tools());
```

Use only the names and parameters returned by this call. The runtime exposes a bounded list of desktop tools; it does not expose arbitrary commands, process arguments, downloads, upgrades or model configuration. Do not guess aliases or reproduce the old `getApp`, `getAXState`, element-index or `frame_id` API. Those belonged to a different implementation.

Call a discovered tool with its exact schema, then display the returned content:

```js
const result = await desktop.call(toolName, toolArguments);
await desktop.emit(result);
```

`toolName` and `toolArguments` above stand for a name and arguments you have actually obtained from `desktop.tools()`. Do not submit these placeholders as literal tool names. Results retain the provider's MCP `content` and `structuredContent`; `desktop.emit` displays text and images without converting screenshots to text.

## Observe, target, verify

1. Inspect the actual apps, windows and current snapshot with the discovered observation tools. Choose the intended application and window explicitly when supported by the schema.
2. Prefer semantic refs returned by the current snapshot. Use a coordinate action only when the provider supports it and the screenshot establishes the target. Respect the provider's coordinate space, display scale and screen bounds; do not translate coordinates using guesses.
3. After a meaningful UI change, a stale-ref error, cancellation or stopping control, take a fresh snapshot before the next action. Never fabricate refs or reuse them for a different app or window.
4. Perform the authorized action once, then observe whether the intended change occurred. A successful API response alone does not prove the UI changed.

Background mode is the default. Do not promise background support for an operation merely because it worked elsewhere. If the provider cannot perform the operation in the background, report that limitation. Only when the user's task allows foreground interaction and it is necessary, opt into foreground for that one call:

```js
const result = await desktop.call(toolName, toolArguments, { headed: true });
await desktop.emit(result);
```

Never retry a background failure automatically in foreground. Do not steal focus as a recovery shortcut.

## Errors and stopping

The SDK submits each call once. It throws `ComputerUseError` for provider errors and keeps the original MCP result in `error.result`. Read `code`, `possibly_sent`, `actionSent` and `dispatchStatus`; preserve the actual diagnostic when explaining a failure.

- If `possibly_sent` is true, or `dispatchStatus` is `"possibly_sent"`, the action may already have reached the app. Do not replay it. Observe the UI before deciding what remains to do.
- A cancellation, timeout or disconnection is not evidence that no action occurred. Do not duplicate a click, submission, file operation or message.
- For denied permissions, unsupported tools or missing runtime resources, explain the actual issue. Do not use shell scripts or another automation technology to bypass the provider's limits.
- On a stop request, stop immediately. End this session's control with `await desktop.stop()`; take a fresh snapshot before resuming a later task.

To display the original provider error without discarding it:

```js
try {
  await desktop.emit(await desktop.call(toolName, toolArguments));
} catch (error) {
  if (error.result) await desktop.emit(error.result);
  throw error;
}
```

## User control and privacy

Keep the user's task, target app and authorized scope explicit. Inspect only the content needed for that task. Screenshots and snapshots may contain private information; do not export, upload or persist them unless the task authorizes that destination and purpose.

Pause for user action when an operating-system security dialog, authentication, CAPTCHA or a protected screen requires it. Do not grant macOS permissions, approve security prompts, disable system protections or infer approval from a timeout. Follow the user's authorization requirements before sending messages, making purchases, deleting data or performing other consequential actions. The existence of a native tool does not authorize its use.

The detailed API reference is available on demand:

```js
nodeRepl.write(await agent.documentation.get("computer-use"));
```
