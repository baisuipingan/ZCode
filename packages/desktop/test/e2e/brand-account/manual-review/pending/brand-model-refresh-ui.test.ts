import { installBrowserAuthorizationFixture } from "./browser-login-fixture.js";
// 原生 UI 验收：真实 Renderer/Main/Host/CLI + loopback 合成 sub2api，不调用生产推理/支付。
// 前置：当前 CLI bundle、desktop build:no-runtime-assets；运行：
// pnpm --filter @zcode/desktop exec tsx --test test/e2e/brand-account/manual-review/pending/brand-model-refresh-ui.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { createManagedInferenceFixture, latch, MI_MODEL } from "./managed-inference-fixture.js";

const root = resolve(import.meta.dirname, "../../../../../../..");
const require = createRequire(import.meta.url);
const MODEL_B = "e2e-agent-model-b";
const DRAFT = "E2E_MUI_KEEP_EXPLICIT_MODEL_AND_DRAFT";
const model = (id: string, displayName: string) => ({
  id,
  display_name: displayName,
  context_window: 128000,
  max_output_tokens: 8192,
  default_max_output_tokens: 4096,
  reasoning_levels: ["none"],
  default_reasoning: "none",
  supports_reasoning: false,
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
  "MUI native model refresh preserves explicit choices and drafts",
  { timeout: 240_000 },
  async () => {
    const artifacts = resolve(
      root,
      "packages/desktop/.e2e-artifacts",
      `brand-model-refresh-ui-${Date.now()}`,
    );
    const data = join(artifacts, "data");
    const workspace = join(artifacts, "workspace");
    await mkdir(join(data, ".zcode/v2"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(data, ".zcode/v2/onboarding-record.json"),
      JSON.stringify({
        version: 2,
        deviceMid: "e2e-model-refresh",
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
    const fixture = await createManagedInferenceFixture(join(workspace, "unused.txt"));
    fixture.state.schemaVersion = 3;
    fixture.state.overrideModels = [
      model(MI_MODEL, "E2E Model Alpha"),
      model(MODEL_B, "E2E Model Beta"),
    ];
    const passed: string[] = [];
    const consoleErrors: string[] = [];
    const rendererRequests = new Set<string>();
    const bootstrapCount = () =>
      fixture.state.requests.filter((request) => request.path === "/api/v1/desktop/bootstrap")
        .length;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let activeGate: ReturnType<typeof latch> | undefined;
    let error: string | undefined;
    try {
      const sourceEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ZCODE_ENV: "production",
        MILOROUTER_ACCOUNT_BASE_URL: fixture.baseUrl,
        ZCODE_DESKTOP_APPLICATION_NAME: `ZCode Model UI E2E ${new URL(fixture.baseUrl).port}`,
        ZCODE_DESKTOP_HOME_DIR: data,
        ZCODE_DESKTOP_USER_DATA_DIR: join(artifacts, "electron"),
        ZCODE_DESKTOP_SESSION_DATA_DIR: join(artifacts, "session"),
        ZCODE_DATA_BASE_DIR: data,
        ZCODE_SESSION_DB_PATH: join(data, ".zcode/cli/db/db.sqlite"),
        ZCODE_STORAGE_DIR: join(data, ".zcode/cli"),
        ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
        NATIVE_SEARCH_TOOLS_ARTIFACT_SOURCE: "repository",
      };
      const env = Object.fromEntries(
        Object.entries(sourceEnv).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && entry[0] !== "ELECTRON_RENDERER_URL",
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
      const activePage = page;
      page.setDefaultTimeout(35_000);
      page.on("pageerror", (cause) => consoleErrors.push(String(cause)));
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.protocol.startsWith("http")) rendererRequests.add(url.origin + url.pathname);
      });
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
      await composer.pressSequentially(DRAFT);
      assert.equal(await composer.innerText(), DRAFT, "Draft must be entered before model actions");
      const trigger = pane.getByTestId("chat-model-select-trigger");
      await trigger.waitFor();
      const menu = page.getByRole("menu");
      const openMenu = async () => {
        if (!(await menu.isVisible())) await trigger.click();
        await menu.waitFor();
      };
      const closeMenu = async () => {
        if (await menu.isVisible()) await activePage.keyboard.press("Escape");
      };
      const refreshMenu = async (expected: "fresh" | "failed" = "fresh") => {
        await openMenu();
        const current = await menu
          .getByTestId("brand-model-sync-status")
          .getAttribute("data-last-successful-at");
        await menu.locator('[data-model-footer-action="refresh-brand-models"]').click();
        await activePage.waitForFunction(
          ({ expected, current }) => {
            const status = document.querySelector(
              '[role="menu"] [data-testid="brand-model-sync-status"]',
            );
            return (
              status?.getAttribute("data-sync-state") === expected &&
              (expected === "failed" || status?.getAttribute("data-last-successful-at") !== current)
            );
          },
          { expected, current },
        );
        assert.equal(await menu.isVisible(), true, "Refresh must keep menu open");
      };
      await openMenu();
      await menu.getByRole("menuitemradio", { name: "E2E Model Alpha", exact: true }).waitFor();
      await menu.getByRole("menuitemradio", { name: "E2E Model Beta", exact: true }).waitFor();
      assert.equal(await menu.getByRole("menuitemradio").count(), 2);
      assert(!/API Key|Provider|供应商|套餐|Coding Plan/u.test(await menu.innerText()));
      await menu.getByRole("menuitemradio", { name: "E2E Model Beta", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="chat-model-select-trigger"]')
          ?.textContent?.includes("E2E Model Beta"),
      );
      assert((await trigger.getAttribute("data-model-current-value"))?.includes(MODEL_B));
      assert.equal(await composer.innerText(), DRAFT);
      passed.push(
        "MUI01: display names, two options, no provider surface; selected ID/draft retained",
      );
      await openMenu();
      await menu.getByRole("menuitemradio", { name: "E2E Model Alpha", exact: true }).click();
      fixture.state.configRevision = "e2e-ui-default-b";
      fixture.state.overrideSelection = { model_id: MODEL_B };
      await refreshMenu();
      assert((await trigger.getAttribute("data-model-current-value"))?.includes(MI_MODEL));
      assert.equal(await composer.innerText(), DRAFT);
      passed.push(
        "MUI02 partial: new-task explicit Alpha survives server default Beta change and refresh",
      );
      assert(
        await page.locator("html").evaluate((node) => node.classList.contains("theme-zai-dark")),
      );
      await page.screenshot({ path: join(artifacts, "01-two-models-dark.png") });
      fixture.state.overrideModels = [model(MODEL_B, "E2E Model Beta")];
      fixture.state.unavailableModels = [
        { model_id: MI_MODEL, display_name: "E2E Model Alpha", reason_code: "model_unavailable" },
      ];
      fixture.state.configRevision = "e2e-ui-remove-alpha";
      await refreshMenu();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[role="menu"] [role="menuitemradio"]').length === 1 &&
          /不可用|Unavailable/u.test(
            document.querySelector('[data-testid="chat-model-select-trigger"]')?.textContent || "",
          ),
      );
      assert((await trigger.getAttribute("data-model-current-value"))?.includes(MI_MODEL));
      assert((await trigger.innerText()).includes(MI_MODEL));
      assert(/不可用|Unavailable/u.test(await trigger.innerText()));
      assert.equal(await menu.getByRole("menuitemradio").count(), 1);
      assert.equal(await composer.innerText(), DRAFT);
      assert.equal(await pane.getByTestId("v4-composer-send").isDisabled(), true);
      await page.screenshot({ path: join(artifacts, "02-removed-model.png") });
      await menu.getByRole("menuitemradio", { name: "E2E Model Beta", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="chat-model-select-trigger"]')
          ?.textContent?.includes("E2E Model Beta"),
      );
      assert((await trigger.getAttribute("data-model-current-value"))?.includes(MODEL_B));
      await pane.getByTestId("v4-composer-send").waitFor({ state: "visible" });
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]')
            ?.disabled === false,
      );
      passed.push("MUI03: removed model ID remains unavailable; only explicit click selects Beta");
      await openMenu();
      const lastSuccess = await menu
        .getByTestId("brand-model-sync-status")
        .getAttribute("data-last-successful-at");
      fixture.state.bootstrapFailureStatus = 503;
      await refreshMenu("failed");
      assert.equal(
        await menu.getByTestId("brand-model-sync-status").getAttribute("data-last-successful-at"),
        lastSuccess,
      );
      assert.equal(await menu.getByRole("menuitemradio").count(), 1);
      assert((await trigger.getAttribute("data-model-current-value"))?.includes(MODEL_B));
      assert.equal(await composer.innerText(), DRAFT);
      await page.screenshot({ path: join(artifacts, "03-refresh-failed.png") });
      fixture.state.bootstrapFailureStatus = 0;
      await refreshMenu();
      passed.push(
        "MUI04 partial: 503 retains directory/selection/draft/time, recovery removes failure",
      );
      await closeMenu();
      const beforeAutomatic = bootstrapCount();
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await openMenu();
      await closeMenu();
      assert.equal(
        bootstrapCount(),
        beforeAutomatic,
        "Fresh automatic intents should be Host-deduplicated",
      );
      passed.push(
        "MUI06 partial: focus/online/visible/menu-open while fresh cause no bootstrap storm",
      );
      await page.getByTestId("brand-account-open").first().click();
      const account = page.getByTestId("brand-account-section");
      await account.waitFor();
      const beforeModel = bootstrapCount();
      const beforeModelSuccess = await account
        .getByTestId("brand-model-sync-status")
        .getAttribute("data-last-successful-at");
      await account.getByTestId("brand-model-refresh").click();
      await page.waitForFunction((lastSuccessfulAt) => {
        const status = document.querySelector(
          '[data-testid="brand-account-section"] [data-testid="brand-model-sync-status"]',
        );
        return (
          status?.getAttribute("data-sync-state") === "fresh" &&
          status?.getAttribute("data-last-successful-at") !== lastSuccessfulAt
        );
      }, beforeModelSuccess);
      assert(bootstrapCount() > beforeModel);
      const beforeBalance = bootstrapCount();
      await account.getByTestId("brand-account-refresh").click();
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>(
            '[data-testid="brand-account-section"] [data-testid="brand-account-refresh"]',
          )?.disabled,
      );
      assert.equal(bootstrapCount(), beforeBalance);
      passed.push(
        "MUI05: account model and balance refresh are independent; successful model time shown",
      );
      await page.screenshot({ path: join(artifacts, "04-account-model-sync.png") });
      await page.setViewportSize({ width: 720, height: 700 });
      await page.screenshot({ path: join(artifacts, "05-account-narrow-dark.png") });
      passed.push(
        "MUI08 partial: macOS packaged renderer account page captured in narrow/dark layout",
      );
      const gate = { started: latch(), finish: latch() };
      activeGate = gate.finish;
      fixture.state.bootstrapGate = gate;
      await account.getByTestId("brand-model-refresh").click();
      await gate.started.promise;
      await page.getByTestId("brand-account-logout").click();
      await page
        .getByRole("button", { name: /退出登录|Sign out/u })
        .last()
        .click();
      await page.getByTestId("brand-account-submit").waitFor();
      gate.finish.release();
      activeGate = undefined;
      fixture.state.browserUserId = 2;
      await page.getByTestId("brand-account-submit").click();
      await page.getByTestId("brand-account-balance").first().waitFor();
      assert(/56\.78/u.test(await page.getByTestId("brand-account-balance").first().innerText()));
      passed.push(
        "MUI07 partial: logout during gated refresh then B login cannot restore A balance/login",
      );
      assert.equal(
        fixture.state.modelRequests.length,
        0,
        "UI checks must not spend inference balance",
      );
      assert(
        ![...rendererRequests].some((url) => /\/coding-plan|\/rewards|\/marketing/u.test(url)),
      );
    } catch (cause) {
      error = String(cause);
      throw cause;
    } finally {
      activeGate?.release();
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
            error,
            consoleErrors,
            requests: fixture.state.requests,
            rendererRequests: [...rendererRequests],
            platform: process.platform,
            arch: process.arch,
            cliBundleSha256: createHash("sha256")
              .update(await readFile(resolve(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs")))
              .digest("hex"),
            scope:
              "loopback-synthetic-native-UI-no-production-inference; pending candidate, not CI admission",
            notCovered: [
              "existing running-session selected model",
              "5-minute real foreground interval",
              "stale automatic refresh",
              "Windows",
              "ordinary-mode comparison",
              "light theme",
              "SSH/WSL/mobile",
            ],
          },
          null,
          2,
        ),
      );
      console.log(`Model refresh UI evidence: ${artifacts}`);
    }
  },
);
