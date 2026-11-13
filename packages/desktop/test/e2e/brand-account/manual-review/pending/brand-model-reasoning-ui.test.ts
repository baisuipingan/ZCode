import { installBrowserAuthorizationFixture } from "./browser-login-fixture.js";
// 原生 UI 验收：真实 Renderer/Main/Host/CLI + loopback 合成 sub2api，不调用生产推理/支付。
// 前置：当前 CLI bundle、desktop build:no-runtime-assets；运行：
// pnpm --filter @zcode/desktop exec tsx --test test/e2e/brand-account/manual-review/pending/brand-model-reasoning-ui.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  createManagedInferenceFixture,
  MI_CONTENT,
  MI_MODEL,
} from "./managed-inference-fixture.js";

const root = resolve(import.meta.dirname, "../../../../../../..");
const require = createRequire(import.meta.url);
const model = (id: string, displayName: string) => ({
  id,
  display_name: displayName,
  context_window: 128000,
  max_output_tokens: 8192,
  default_max_output_tokens: 4096,
  reasoning_levels: ["low", "medium", "high"],
  default_reasoning: "medium",
  supports_reasoning: true,
  supports_streaming: true,
  requires_mfjs_tool_schema: false,
  input: { text: true, image: false, video: false, audio: false, pdf: false },
  output: { text: true },
  supports_tool_call: true,
  supports_json_schema_output: false,
  supports_native_web_search: false,
  supports_mid_conversation_system: true,
});

async function createProject(app: ElectronApplication, page: Page, workspace: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByTestId("project-section").hover();
  await page.getByTestId("virtual-project-add").click();
  await page.getByTestId("virtual-project-name").fill("E2E_MODEL_REFRESH");
  await page.getByTestId("virtual-project-browse").click();
  await page.getByTestId("virtual-project-root-name").filter({ hasText: "workspace" }).waitFor();
  await page.getByTestId("virtual-project-save").click();
  await page.getByTestId("project-folder-trust-confirm").click();
  const project = page.locator('[data-project-name="E2E_MODEL_REFRESH"]');
  await project.waitFor();
  await project.hover();
  await project.getByTestId("virtual-project-create-task").click();
}

test(
  "RUI native model effort reaches all three Responses through real Write and Read",
  { timeout: 240_000 },
  async () => {
    const artifacts = resolve(
      root,
      "packages/desktop/.e2e-artifacts",
      `brand-model-reasoning-ui-${Date.now()}`,
    );
    const data = join(artifacts, "data");
    const workspace = join(artifacts, "workspace");
    await mkdir(join(data, ".zcode/v2"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(data, ".zcode/v2/onboarding-record.json"),
      JSON.stringify({
        version: 2,
        deviceMid: "e2e-reasoning",
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
    const outputFile = join(workspace, "reasoning-output.txt");
    const fixture = await createManagedInferenceFixture(outputFile);
    fixture.state.schemaVersion = 3;
    fixture.state.overrideModels = [model(MI_MODEL, "E2E Reasoning Model")];
    fixture.state.overrideSelection = { reasoning_level: "medium" };
    const errors: string[] = [];
    const passed: string[] = [];
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let failure: string | undefined;
    try {
      const sourceEnv = {
        ...process.env,
        ZCODE_ENV: "production",
        MILOROUTER_ACCOUNT_BASE_URL: fixture.baseUrl,
        ZCODE_DESKTOP_APPLICATION_NAME: `ZCode Reasoning E2E ${new URL(fixture.baseUrl).port}`,
        ZCODE_DESKTOP_HOME_DIR: data,
        ZCODE_DESKTOP_USER_DATA_DIR: join(artifacts, "electron"),
        ZCODE_DESKTOP_SESSION_DATA_DIR: join(artifacts, "session"),
        ZCODE_DATA_BASE_DIR: data,
        ZCODE_SESSION_DB_PATH: join(data, ".zcode/cli/db/db.sqlite"),
        ZCODE_STORAGE_DIR: join(data, ".zcode/cli"),
        ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
        NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repository",
        ...(process.env.ZCODE_ACCOUNT_E2E_RENDERER_URL
          ? { ELECTRON_RENDERER_URL: process.env.ZCODE_ACCOUNT_E2E_RENDERER_URL }
          : {}),
      };
      const env = Object.fromEntries(
        Object.entries(sourceEnv).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" &&
            (entry[0] !== "ELECTRON_RENDERER_URL" ||
              Boolean(process.env.ZCODE_ACCOUNT_E2E_RENDERER_URL)),
        ),
      );
      app = await electron.launch({
        executablePath: require("electron"),
        args: [resolve(root, "packages/desktop")],
        env,
        timeout: 45_000,
      });
      await installBrowserAuthorizationFixture(app, fixture.baseUrl);
      page = await app.firstWindow({ timeout: 40_000 });
      page.setDefaultTimeout(35_000);
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.getByTestId("brand-account-submit").click();
      await page.getByTestId("brand-account-balance").first().waitFor();
      await createProject(app, page, workspace);
      const pane = page.getByTestId("v4-session-pane-workspace-main");
      const composer = pane.getByTestId("v4-composer-input");
      await composer.waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]')
            ?.isContentEditable === true,
      );
      await composer.pressSequentially(
        `Write ${outputFile} containing exactly ${MI_CONTENT.trim()}, then Read it and report completion.`,
      );
      const trigger = pane.getByTestId("chat-model-select-trigger");
      await trigger.click();
      const slider = page.getByTestId("composer-thought-slider");
      await slider.waitFor();
      assert.equal(await page.getByTestId("composer-provider-trigger").count(), 0);
      assert.deepEqual(JSON.parse((await slider.getAttribute("data-levels"))!), [
        "low",
        "medium",
        "high",
      ]);
      await slider.focus();
      await page.keyboard.press("End");
      await page.waitForFunction(() =>
        /高|High/.test(
          document.querySelector('[data-testid="chat-model-select-trigger"]')?.textContent ?? "",
        ),
      );
      await page.getByRole("menuitemradio").filter({ hasText: "E2E Reasoning Model" }).click();
      assert.match(await trigger.innerText(), /高|High/);
      await page.keyboard.press("Escape");
      await pane.getByTestId("v4-composer-send").click();
      const completed = pane.getByText("E2E_MI05_DONE: created and read the real file.", {
        exact: true,
      });
      await page.waitForFunction(
        () =>
          document.body.textContent?.includes("E2E_MI05_DONE: created and read the real file.") ||
          Boolean(document.querySelector('button[data-permission-option-kind="allowOnce"]')),
        undefined,
        { timeout: 120_000 },
      );
      const approve = page.locator('button[data-permission-option-kind="allowOnce"]');
      if (await approve.isVisible()) {
        // 审批期间产品隐藏 Composer；走真实审批入口，不操作隐藏的草稿控件。
        // 下条草稿不改写已接受参数的语义由组件浏览器验收单独覆盖。
        await approve.click();
        passed.push("Real Write permission was approved through the existing UI");
      }
      await completed.waitFor({ timeout: 120_000 });
      assert.equal(await readFile(outputFile, "utf8"), MI_CONTENT);
      const main = fixture.state.modelRequests.filter((request) => request.workClass === "main");
      assert.equal(main.length, 3);
      assert(
        main.every(
          (request) =>
            request.reasoningEffort === "high" && request.stream && request.account === 1,
        ),
      );
      assert.equal(main[2]!.sawReadResult, true);
      assert.equal(fixture.state.violations.length, 0);
      assert.deepEqual(errors, []);
      passed.push("Actual Responses carries high across all three real Write/Read model attempts");
      await page.screenshot({ path: join(artifacts, "completed.png") });
    } catch (cause) {
      failure = String(cause);
      throw cause;
    } finally {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(artifacts, "last-state.png") }).catch(() => {});
        await writeFile(
          join(artifacts, "last-state.txt"),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        );
      }
      await app?.close().catch(() => {});
      await fixture.close();
      await writeFile(
        join(artifacts, "result.json"),
        JSON.stringify(
          {
            passed,
            failure,
            errors,
            modelRequests: fixture.state.modelRequests,
            violations: fixture.state.violations,
            cliBundleSha256: createHash("sha256")
              .update(await readFile(resolve(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs")))
              .digest("hex"),
            scope:
              "loopback-synthetic-native-UI-actual-Responses-no-production-inference; pending candidate",
          },
          null,
          2,
        ),
      );
      console.log(`Reasoning UI evidence: ${artifacts}`);
    }
  },
);
