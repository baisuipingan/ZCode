import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNativeSetupDiagnostic } from "../windows-native-setup-diagnostic.mjs";

test("failure diagnostics use the filtered native environment, preserve the exact failure, and clean their own state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "milocode-native-diagnostic-"));
  try {
    // Node 充当无桌面访问的 CLI fixture；session 是被实际子进程执行的脚本。
    await writeFile(
      join(directory, "session"),
      `const fs = require("node:fs");
if (process.argv.slice(2).join(" ") !== "start --no-trace --name MiloCode") process.exit(91);
if (process.env.GH_TOKEN || process.env.DIAGNOSTIC_SECRET || !process.env.AGENT_DESKTOP_HOME) process.exit(92);
fs.writeFileSync(require("node:path").join(process.env.AGENT_DESKTOP_HOME,"owned-state"),"fixture");
process.stdout.write(JSON.stringify({ok:false,error:{code:"CONTROLLED_FAILURE"}}));
process.stderr.write("controlled setup failure");
process.exit(42);`,
    );
    const report = await runNativeSetupDiagnostic({
      binary: process.execPath,
      directory,
      env: { ...process.env, GH_TOKEN: "never-copy-this", DIAGNOSTIC_SECRET: "never-copy-this" },
    });
    assert.equal(report.commands.length, 2);
    assert.deepEqual(report.commands[0].args, ["--version"]);
    assert.equal(report.commands[0].exitCode, 0);
    assert.deepEqual(report.commands[1].args, [
      "session",
      "start",
      "--no-trace",
      "--name",
      "MiloCode",
    ]);
    assert.equal(report.commands[1].exitCode, 42);
    assert.equal(report.commands[1].stderr, "controlled setup failure");
    assert.match(report.commands[1].stdout, /CONTROLLED_FAILURE/u);
    assert.equal(report.stateRemoved, true);
    assert.equal((await readdir(directory)).includes("native-setup-state"), false);
    const saved = await readFile(join(directory, "native-setup-diagnostic.json"), "utf8");
    assert.equal(saved.includes("never-copy-this"), false);
    assert.equal(saved.includes("GH_TOKEN"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unavailable final binary is recorded without hiding the original native launch error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "milocode-native-missing-"));
  try {
    const report = await runNativeSetupDiagnostic({
      binary: join(directory, "missing-native-binary"),
      directory,
    });
    assert.equal(report.commands.length, 2);
    assert.equal(
      report.commands.every((command) => command.spawnError?.code === "ENOENT"),
      true,
    );
    assert.equal(report.stateRemoved, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
