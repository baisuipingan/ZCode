import { spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { nativeEnvironment } from "../packages/zcode-cua/src/agent-desktop/process.js";

const MAX_DIAGNOSTIC_OUTPUT = 16_384;

async function runCommand(binary, args, env, cwd) {
  return await new Promise((resolve) => {
    const result = { args, exitCode: null, stdout: "", stderr: "" };
    const child = spawn(binary, args, {
      env,
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const channel of ["stdout", "stderr"]) {
      child[channel].setEncoding("utf8");
      child[channel].on("data", (chunk) => {
        result[channel] = (result[channel] + chunk).slice(0, MAX_DIAGNOSTIC_OUTPUT);
      });
    }
    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill();
    }, 10_000);
    child.once("error", (error) => {
      result.spawnError = { code: error.code, message: error.message };
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      result.exitCode = code;
      if (signal) result.signal = signal;
      resolve(result);
    });
  });
}

export async function runNativeSetupDiagnostic({ binary, directory, env = process.env }) {
  const state = join(directory, "native-setup-state");
  const filtered = nativeEnvironment(env, state);
  const facts = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"]) {
    const value = filtered[key];
    facts[key] = {
      present: typeof value === "string",
      absolute: typeof value === "string" && isAbsolute(value),
      directoryExists: value
        ? (await stat(value).catch(() => undefined))?.isDirectory() === true
        : false,
    };
  }
  const report = {
    schemaVersion: 1,
    scope: "Setup-only diagnostic: fixed version/session commands; no desktop observation or input",
    binary,
    environmentFacts: facts,
    commands: [],
  };
  // session start 不读取桌面；仅此受控命令允许保留 stderr，不能扩大到普通原生调用。
  // 使用产品现有 nativeEnvironment，避免诊断另造一套环境后得出错误结论。
  // Windows 上 mkdir(mode:0700) 不会收紧继承的 DACL。叶目录必须由原生
  // session start 首次创建并保护，诊断不能预建它而重新制造同一故障。
  try {
    for (const args of [["--version"], ["session", "start", "--no-trace", "--name", "MiloCode"]]) {
      report.commands.push(await runCommand(binary, args, filtered, directory));
    }
  } finally {
    await rm(state, { recursive: true, force: true });
    report.stateRemoved = true;
    await writeFile(
      join(directory, "native-setup-diagnostic.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return report;
}
