import { installBrowserAuthorizationFixture } from "./browser-login-fixture.js";
// 独立原生验收；只连接本地假sub2api，不创建生产Key/消费或支付。
// 前置：当前CLI bundle、desktop产物与renderer（开发URL或显式file构建路径）。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  createManagedInferenceFixture,
  MI_CONTENT,
  MI_SECRETS,
} from "./managed-inference-fixture.js";

const root = resolve(import.meta.dirname, "../../../../../../..");
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

function assertNoSecrets(value: string, surface: string) {
  for (const secret of MI_SECRETS) assert(!value.includes(secret), `${surface} exposed ${secret}`);
}

async function scanFiles(directory: string): Promise<string[]> {
  const scanned: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scanned.push(...(await scanFiles(path)));
    else if (entry.isFile()) {
      assertNoSecrets((await readFile(path)).toString("utf8"), path);
      scanned.push(path);
    }
  }
  return scanned;
}

async function createProject(app: ElectronApplication, page: Page, workspace: string) {
  // 只替代系统文件选择结果；项目保存、信任确认与Host执行仍走产品真实链路。
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByTestId("project-section").hover();
  await page.getByTestId("virtual-project-add").click();
  await page.getByTestId("virtual-project-name").fill("E2E_MANAGED_INFERENCE");
  await page.getByTestId("virtual-project-browse").click();
  await page.getByTestId("virtual-project-root-name").filter({ hasText: "workspace" }).waitFor();
  await page.getByTestId("virtual-project-save").click();
  await page.getByTestId("project-folder-trust-confirm").click();
  const project = page.locator('[data-project-name="E2E_MANAGED_INFERENCE"]');
  await project.waitFor();
  await project.hover();
  await project.getByTestId("virtual-project-create-task").click();
}

test(
  "MI05/06-title/11 native managed Responses invokes real Write and Read",
  { timeout: 240_000 },
  async () => {
    const artifacts = resolve(
      root,
      "packages/desktop/.e2e-artifacts",
      `brand-managed-inference-${Date.now()}`,
    );
    const data = join(artifacts, "data");
    const workspace = join(artifacts, "workspace");
    await mkdir(data, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const appConfig = join(data, ".zcode/v2");
    await mkdir(appConfig, { recursive: true });
    // 本case不验收职业引导。按owner的设备级资格合同预置“已关闭”，避免把是否存在
    // 历史CLI会话造成的资格差异误当成固定三步；登录、权限与推理仍走真实产品链路。
    await writeFile(
      join(appConfig, "onboarding-record.json"),
      JSON.stringify({
        version: 2,
        deviceMid: "e2e-managed-inference",
        entries: [],
        decisions: [
          {
            userId: null,
            status: "dismissed",
            reason: "user_closed",
            decidedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const outputFile = join(workspace, "E2E_MI05-output.txt");
    const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const cliBundleSha256 = createHash("sha256")
      .update(await readFile(resolve(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs")))
      .digest("hex");
    const fixture = await createManagedInferenceFixture(outputFile);
    fixture.state.schemaVersion = 3;
    const passed: string[] = [];
    const rendererRequests = new Set<string>();
    const navigation: string[] = [];
    const processOutput: string[] = [];
    const rendererOrigin = new URL(
      process.env.ZCODE_ACCOUNT_E2E_RENDERER_URL ?? "http://localhost:5174",
    ).origin;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let scanned: string[] = [];
    let processArgs: string[] = [];
    let cliSpawnEvidence: unknown[] = [];
    let errorMessage: string | undefined;
    let outputSha256: string | undefined;
    try {
      app = await electron.launch({
        executablePath: process.env.ZCODE_ACCOUNT_E2E_EXECUTABLE ?? require("electron"),
        args: [resolve(root, "packages/desktop")],
        env: {
          ...process.env,
          ZCODE_ENV: "production",
          ELECTRON_RENDERER_URL:
            process.env.ZCODE_ACCOUNT_E2E_RENDERER_URL ?? "http://localhost:5174",
          MILOROUTER_ACCOUNT_BASE_URL: fixture.baseUrl,
          ZCODE_DESKTOP_APPLICATION_NAME: `ZCode Managed E2E ${new URL(fixture.baseUrl).port}`,
          ZCODE_DESKTOP_HOME_DIR: data,
          ZCODE_DESKTOP_USER_DATA_DIR: join(artifacts, "electron"),
          ZCODE_DESKTOP_SESSION_DATA_DIR: join(artifacts, "session"),
          ZCODE_DATA_BASE_DIR: data,
          // CLI session/storage不跟随App dataBaseDir，必须分别显式隔离。
          ZCODE_SESSION_DB_PATH: join(data, ".zcode/cli/db/db.sqlite"),
          ZCODE_STORAGE_DIR: join(data, ".zcode/cli"),
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
          NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repository",
        },
        timeout: 45_000,
      });
      app
        .process()
        .stderr?.on("data", (chunk: Buffer) => processOutput.push(chunk.toString("utf8")));
      app
        .process()
        .stdout?.on("data", (chunk: Buffer) => processOutput.push(chunk.toString("utf8")));
      await installBrowserAuthorizationFixture(app, fixture.baseUrl);
      page = await app.firstWindow({ timeout: 40_000 });
      page.setDefaultTimeout(60_000);
      page.on("framenavigated", (frame) => {
        if (frame === page?.mainFrame()) navigation.push(frame.url());
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== rendererOrigin && url.protocol !== "blob:")
          rendererRequests.add(url.origin + url.pathname);
      });
      await page.getByTestId("brand-account-submit").waitFor();
      await page.evaluate(() => {
        // Vite开发专用observer会覆盖紫色组件标签，关闭其公开调试开关获取真实UI截图。
        // 不隐藏产品节点、不改变权限/账号/推理状态，正式build本来不注入此脚本。
        const scan = (
          window as Window & {
            reactScan?: (options: { enabled: boolean; showToolbar: boolean }) => void;
          }
        ).reactScan;
        scan?.({ enabled: false, showToolbar: false });
      });
      await page.getByTestId("brand-account-submit").click();
      await page.getByTestId("brand-account-balance").first().waitFor();
      passed.push("MI05 setup: authenticated with balance while payment is disabled");
      await createProject(app, page, workspace);
      const pane = page.locator('[data-testid="v4-session-pane-workspace-main"]');
      const composer = pane.getByTestId("v4-composer-input");
      await composer.waitFor();
      await composer.click();
      // Lexical的fill会跳过逐键编辑路径，并可能被异步草稿恢复覆盖；使用真实键盘输入。
      await composer.pressSequentially(
        `E2E_MI05: Write ${outputFile} containing exactly ${MI_CONTENT.trim()}, then Read it and report completion. Use the real Write and Read tools.`,
      );
      const send = pane.getByTestId("v4-composer-send");
      await send.click();
      const completed = pane.getByText("E2E_MI05_DONE: created and read the real file.", {
        exact: true,
      });
      await page.waitForFunction(
        () =>
          document.body.textContent?.includes("E2E_MI05_DONE: created and read the real file.") ||
          document.body.textContent?.includes('"invalid_format"') ||
          Boolean(document.querySelector('button[data-permission-option-kind="allowOnce"]')),
        undefined,
        { timeout: 120_000 },
      );
      const approveOnce = page.locator('button[data-permission-option-kind="allowOnce"]');
      if (await approveOnce.isVisible()) {
        await page.screenshot({ path: join(artifacts, "00-write-permission.png") });
        await approveOnce.click();
        passed.push("MI05 permission: real Write approval shown and allowed once through UI");
        await completed.waitFor({ timeout: 120_000 });
      }
      if (!(await completed.isVisible()))
        throw new Error(
          `Managed runtime rejected before completion: ${(await pane.innerText()).slice(-5000)}`,
        );
      assert.equal(await readFile(outputFile, "utf8"), MI_CONTENT);
      outputSha256 = createHash("sha256")
        .update(await readFile(outputFile))
        .digest("hex");
      const main = fixture.state.modelRequests.filter((request) => request.workClass === "main");
      assert.equal(main.length, 3);
      assert(
        main.every(
          (request) => request.account === 1 && request.stream && request.path === "/v1/responses",
        ),
      );
      assert.equal(main[2]!.sawReadResult, true);
      // 标题是异步sidecar，正文完成不等于辅助HTTP已到达；等待可观察的请求事实再断言。
      let titleDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          fixture.state.titleObserved.promise,
          new Promise<never>((_, reject) => {
            titleDeadline = setTimeout(
              () => reject(new Error("Title sidecar request was not observed")),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(titleDeadline);
      }
      assert(
        fixture.state.modelRequests.some((request) => request.workClass === "title"),
        "Title sidecar needs its own observed request",
      );
      assert.equal(fixture.state.violations.length, 0, JSON.stringify(fixture.state.violations));
      passed.push("MI05: real Main/Host/CLI Responses Write then Read, exact file and tool result");
      passed.push(
        "MI06 partial: title and all observed main requests use managed model/Agent auth",
      );
      await page.screenshot({ path: join(artifacts, "01-real-tool-completed.png") });
      const renderer = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          url: location.href,
          dom: document.body.innerHTML,
        }),
      );
      assertNoSecrets(renderer, "Renderer DOM/storage/URL");
      const ps = await exec("ps", ["-axo", "pid=,ppid=,args="]);
      const rows = ps.stdout
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
        .filter((match) => match !== null);
      const ids = new Set([app.process().pid!]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const row of rows)
          if (ids.has(Number(row[2])) && !ids.has(Number(row[1]))) {
            ids.add(Number(row[1]));
            changed = true;
          }
      }
      processArgs = rows.filter((row) => ids.has(Number(row[1]))).map((row) => row[3]!);
      const logDirectory = join(data, ".zcode/v2/logs");
      const hostLogs = await Promise.all(
        (await readdir(logDirectory))
          .filter((name) => name.endsWith(".log"))
          .map((name) => readFile(join(logDirectory, name), "utf8")),
      );
      const spawnMarker = "ZCode agent spawn preflight ";
      cliSpawnEvidence = hostLogs
        .join("\n")
        .split("\n")
        .filter((line) => line.includes(spawnMarker))
        .map((line) => JSON.parse(line.slice(line.indexOf(spawnMarker) + spawnMarker.length)));
      // CLI主动把process.title设为zcode-cli，ps不再保留原argv。以Host精确spawn记录
      // 加当前进程树中的CLI身份联合证明真实入口；argv本身仍执行秘密哨兵扫描。
      assert(
        processArgs.some((args) => args.trim() === "zcode-cli") &&
          cliSpawnEvidence.some((entry) => {
            const value = entry as { spawnPreflight?: { args?: string[] } };
            return (
              value.spawnPreflight?.args?.[0] ===
                resolve(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs") &&
              value.spawnPreflight.args.includes("app-server")
            );
          }),
        "Must run current real CLI bundle",
      );
      assertNoSecrets(processArgs.join("\n"), "Process arguments");
      const activePrivateSession = await readFile(
        join(artifacts, "electron/brand-account/session.json"),
        "utf8",
      );
      assertNoSecrets(activePrivateSession, "Active encrypted login store");
      scanned = await scanFiles(data);
      await page.getByTestId("brand-account-open").first().click();
      const usage = page.getByTestId("brand-usage-section");
      await usage.waitFor();
      await usage
        .getByTestId("brand-usage-amount")
        .filter({ hasText: "9007199.254740993" })
        .waitFor();
      assert(
        (await usage.innerText()).includes("0.01"),
        "Legacy positive actual_cost must remain a visible charge",
      );
      assert(
        (await usage.innerText()).includes("20"),
        "Usage scope must disclose recent twenty records",
      );
      passed.push(
        "MI12 partial: current Agent connection usage, exact int64-derived USD and legacy positive charge shown",
      );
      await page.screenshot({ path: join(artifacts, "02-usage-fresh.png") });
      fixture.state.usageFails = true;
      await usage.getByTestId("brand-usage-refresh").click();
      await page.waitForFunction(() =>
        /同步失败|Sync failed|刷新失败|Refresh failed/u.test(
          document.querySelector('[data-testid="brand-usage-status"]')?.textContent ?? "",
        ),
      );
      assert(
        (await usage.innerText()).includes("9007199.254740993"),
        "Stale usage preserves settled rows",
      );
      await page.screenshot({ path: join(artifacts, "03-usage-stale.png") });
      fixture.state.usageFails = false;
      fixture.state.usageEmpty = true;
      await usage.getByTestId("brand-usage-refresh").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="brand-usage-section"]')
            ?.textContent?.includes("暂未查到已结算记录") ||
          document
            .querySelector('[data-testid="brand-usage-section"]')
            ?.textContent?.includes("No settled"),
      );
      assert.equal(
        await usage.getByTestId("brand-usage-amount").count(),
        0,
        "Empty usage is not a displayed zero amount",
      );
      await page.screenshot({ path: join(artifacts, "04-usage-empty.png") });
      passed.push(
        "MI12 partial: refresh failure retains stale rows; empty settled list is not zero spend",
      );
      await page.getByTestId("brand-account-logout").click();
      await page
        .getByRole("button", { name: /退出登录|Sign out/u })
        .last()
        .click();
      await page.getByTestId("brand-account-submit").waitFor();
      passed.push("MI07 partial: logout returns to login after completed run; files preserved");
      assert.equal(await readFile(outputFile, "utf8"), MI_CONTENT);
      assert(
        ![...rendererRequests].some((url) => /\/coding-plan|\/rewards|\/marketing/u.test(url)),
      );
      assertNoSecrets(processOutput.join("\n"), "Main stdout/stderr");
      await app.close();
      app = undefined;
      scanned = [...new Set([...scanned, ...(await scanFiles(data))])];
      passed.push(
        "MI11 partial: Renderer, process argv, Main output and data/config/snapshots/logs contain no secret sentinels",
      );
    } catch (error) {
      errorMessage = String(error);
      throw error;
    } finally {
      if (page && !page.isClosed())
        await page.screenshot({ path: join(artifacts, "last-state.png") }).catch(() => {});
      await app?.close().catch(() => {});
      await fixture.close();
      const result = {
        passed,
        error: errorMessage,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        commit,
        cliBundleSha256,
        command:
          "ZCODE_ACCOUNT_E2E_RENDERER_URL=http://127.0.0.1:5174 pnpm --filter @zcode/desktop exec tsx --test test/e2e/brand-account/manual-review/pending/brand-managed-inference.test.ts",
        fixture: "loopback-synthetic-no-production-inference",
        networkLimit: "Renderer plus gateway observations; no claim of process-wide packet capture",
        modelRequests: fixture.state.modelRequests,
        requests: fixture.state.requests,
        violations: fixture.state.violations,
        rendererRequests: [...rendererRequests],
        navigation,
        processArgs,
        cliSpawnEvidence,
        scanned,
        outputFile,
        outputSha256,
      };
      const serialized = JSON.stringify(result, null, 2);
      assertNoSecrets(serialized, "Evidence artifact");
      await writeFile(join(artifacts, "result.json"), serialized);
      await writeFile(
        join(artifacts, "gateway-trace.json"),
        JSON.stringify(fixture.state.modelRequests, null, 2),
      );
      console.log(`Managed inference evidence: ${artifacts}`);
    }
  },
);
