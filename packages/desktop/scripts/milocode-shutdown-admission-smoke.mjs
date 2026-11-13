import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 执行真实 Main/Host 源函数，仅替换进程和外部退出资源；不启动、关闭真实应用。
const desktopRoot = resolve(import.meta.dirname, "..");
const hostSource = await readFile(resolve(desktopRoot, "src/main/desktopHostProcess.ts"), "utf8");
const mainSource = await readFile(resolve(desktopRoot, "src/main/index.ts"), "utf8");
function declarations(source, names) {
  const ast = ts.createSourceFile("admission.ts", source, ts.ScriptTarget.Latest, true);
  return names
    .map((name) => {
      const node = ast.statements.find(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      assert.ok(node, `missing real source function ${name}`);
      return node.getText(ast);
    })
    .join("\n");
}
const hostFunctions = declarations(hostSource, [
  "listDisposingHostProcesses",
  "disposeHostProcess",
  "disposeHostProcessAndWait",
  "assertHostProcessesExitedForUpdate",
]);
const mainFunction = declarations(mainSource, ["prepareAppQuit"]);
const results = [];
for (const scenario of [
  "update-real-exit",
  "update-timeout",
  "update-cleanup-rejection",
  "update-cron-rejection",
  "update-trace-rejection",
  "normal-timeout-unchanged",
  "normal-rejection-unchanged",
  "join-normal-timeout",
  "reuse-normal-timeout",
  "join-normal-rejection",
  "reuse-normal-rejection",
  "reuse-normal-real-exit",
  "update-empty-hosts",
]) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.postMessage = () => {};
  child.kill = () => true; // kill() 成功不代表真实 exit，必须等待权威事件。
  const hosts = new Map(scenario === "update-empty-hosts" ? [] : [[1, child]]);
  const logger = { info() {}, warn() {}, error() {} };
  const rejected =
    scenario.includes("rejection") && !scenario.includes("cron") && !scenario.includes("trace");
  const noop = () => {};
  const sandbox = vm.createContext({
    exports: {},
    HostMessageTypes: { Dispose: "dispose" },
    process: { platform: "darwin" },
    setTimeout: (callback, delay) => {
      const timer = setTimeout(callback, delay >= 3500 ? 1 : delay);
      // 工程进程没有真实窗口/IPC owner 保活，不能让产品 unref 提前结束验收。
      timer.unref = () => timer;
      return timer;
    },
    clearTimeout,
    logger,
    activeAppShutdownKind: null,
    activeAppShutdownPolicy: { forceKillDelayMs: 1, waitTimeoutMs: 8 },
    selectAppShutdownPolicy: (activeKind, requestedKind) => ({
      kind:
        activeKind === "update-install" || requestedKind === "update-install"
          ? "update-install"
          : "normal",
      policy: { forceKillDelayMs: 1, waitTimeoutMs: 8 },
      upgraded: activeKind === "normal" && requestedKind === "update-install",
    }),
    appQuitPreparationInFlight: null,
    hasPreparedAppQuit: false,
    appQuitPreparationFailed: false,
    appQuitHostProcesses: new Set(),
    windowHostProcessMap: hosts,
    disposingHostProcessTimers: new WeakMap(),
    markForceQuit: noop,
    windowsCuaOperationIndicator: { dispose: noop },
    browserScreenshotSurfaceCoordinator: { dispose: noop },
    stopDesktopResourceTelemetry: noop,
    stopDesktopZCodeDataSizeTelemetry: noop,
    stopDesktopNetworkTelemetry: noop,
    stopRemoteUsageArmsPeriodicSampling: noop,
    disposeRendererActionTraceIpc: undefined,
    notifyStabilityAppExit: noop,
    getStabilityLifecycleScene: () => "update_install",
    cronScheduler: {
      dispose: async () => {
        if (scenario === "update-cron-rejection") throw new Error("fixture cron rejection");
      },
    },
    appTelemetryCore: { flushPendingReports: async () => {} },
    localTtftExporter: { shutdown: async () => {} },
    flushLocalTtftLogs: async () => {},
    rendererActionTraceBroker: {
      shutdown: async () => {
        if (scenario === "update-trace-rejection") throw new Error("fixture trace rejection");
      },
    },
    remoteSessionManager: {
      disposeAllAndWaitForAppShutdown: async () => {
        if (rejected) throw new Error("fixture shutdown rejection");
      },
    },
  });
  const code = ts.transpileModule(
    `const exitedHostProcesses = new WeakSet();\nconst disposingHostProcesses = new Set();\n${hostFunctions}\n${mainFunction}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  vm.runInContext(code, sandbox, { filename: "real-main-host-shutdown.js" });
  const prepare = vm.runInContext("prepareAppQuit", sandbox);
  try {
    if (scenario === "update-real-exit") {
      const result = prepare("engineering", "update-install");
      child.emit("exit", 0);
      await result;
    } else if (scenario === "reuse-normal-real-exit") {
      const normal = prepare("engineering-normal", "normal");
      child.emit("exit", 0);
      await normal;
      hosts.clear();
      await prepare("engineering-update", "update-install");
    } else if (scenario === "join-normal-timeout") {
      const normal = prepare("engineering-normal", "normal");
      hosts.clear();
      const update = prepare("engineering-update", "update-install");
      await assert.rejects(update, /shutdown|Host.*exit/i);
      await normal;
    } else if (scenario === "reuse-normal-timeout") {
      await prepare("engineering-normal", "normal");
      hosts.clear();
      await assert.rejects(prepare("engineering-update", "update-install"), /shutdown|Host.*exit/i);
    } else if (scenario === "join-normal-rejection" || scenario === "reuse-normal-rejection") {
      const normal = prepare("engineering-normal", "normal");
      child.emit("exit", 0);
      hosts.clear();
      if (scenario === "reuse-normal-rejection") await normal;
      await assert.rejects(prepare("engineering-update", "update-install"), /shutdown|Host.*exit/i);
      await normal;
    } else if (scenario.startsWith("update-") && scenario.includes("rejection")) {
      const result = prepare("engineering", "update-install");
      child.emit("exit", 0);
      await assert.rejects(result, /shutdown|Host.*exit/i);
    } else if (scenario === "update-timeout") {
      await assert.rejects(prepare("engineering", "update-install"), /shutdown|Host.*exit/i);
    } else {
      await prepare("engineering", scenario.startsWith("normal") ? "normal" : "update-install");
    }
    results.push({ scenario, passed: true });
  } finally {
    child.emit("exit", 0);
  }
}
const evidenceRoot = resolve(desktopRoot, ".e2e-artifacts");
await mkdir(evidenceRoot, { recursive: true });
const outputDir = await mkdtemp(resolve(evidenceRoot, "milocode-shutdown-admission-"));
await writeFile(
  resolve(outputDir, "result.json"),
  JSON.stringify({ results, passed: true }, null, 2) + "\n",
);
console.log(
  `MiloCode real Main/Host shutdown admission: ${results.length}/${results.length} passed; ${outputDir}`,
);
