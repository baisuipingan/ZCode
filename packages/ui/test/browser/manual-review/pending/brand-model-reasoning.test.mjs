// 真实React登录页、现有组件和样式；本地合成账户，不连接生产。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/brand-model-reasoning.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/brand-model-reasoning");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "brand-reasoning-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const level = (page) =>
  page.evaluate(() => window.__brandReasoning?.selection?.options?.reasoningLevel);
const waitLevel = (page, value) =>
  page.waitForFunction(
    (expected) =>
      window.__brandReasoning?.selection?.options?.reasoningLevel === expected &&
      Boolean(window.__brandReasoning?.submission),
    value,
  );
async function ready(page, params = "theme=dark&locale=en-US") {
  await page.goto(`${origin}fixture?${params}`);
  await waitLevel(page, "medium");
}
async function open(page) {
  if (!(await page.getByRole("menu").isVisible()))
    await page.getByTestId("chat-model-select-trigger").click();
  await page.getByRole("menu").waitFor();
}
async function close(page) {
  if (await page.getByRole("menu").isVisible()) await page.keyboard.press("Escape");
}
async function choose(page, name) {
  await open(page);
  await page
    .getByRole("menuitemradio")
    .filter({ hasText: `Model ${name}` })
    .click();
}

test("RUI01/02 real draft owner preserves same-model effort, adopts target default and freezes accepted selection", async () => {
  const page = await browser.newPage();
  try {
    await ready(page);
    await open(page);
    assert.equal(await page.getByTestId("composer-provider-trigger").count(), 0);
    assert.deepEqual(
      JSON.parse(await page.getByTestId("composer-thought-slider").getAttribute("data-levels")),
      ["low", "medium", "high"],
    );
    assert.match(await page.getByTestId("composer-thought-default").innerText(), /Medium/);
    await page.getByTestId("composer-thought-slider").focus();
    await page.keyboard.press("End");
    await waitLevel(page, "high");
    await close(page);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="v4-composer-input"]') === document.activeElement,
    );
    await choose(page, "Alpha");
    assert.equal(await level(page), "high");
    await choose(page, "Beta");
    await waitLevel(page, "xhigh");
    await page.evaluate(() =>
      window.__brandReasoning.changeCatalog("Beta", ["minimal", "xhigh", "max"], "minimal"),
    );
    await open(page);
    await page.getByTestId("composer-thought-default").filter({ hasText: "Minimal" }).waitFor();
    assert.equal(await level(page), "xhigh");
    assert.deepEqual(
      JSON.parse(await page.getByTestId("composer-thought-slider").getAttribute("data-levels")),
      ["minimal", "xhigh", "max"],
    );
    await close(page);
    await page.getByTestId("accept").click();
    await page.keyboard.press("Control+t");
    await waitLevel(page, "max");
    assert.equal(
      await page.evaluate(
        () => window.__brandReasoning.accepted.modelSelection.options.reasoningLevel,
      ),
      "xhigh",
    );
    assert.equal(await page.getByTestId("v4-composer-input").innerText(), "KEEP_DRAFT");
  } finally {
    await page.close();
  }
});

test("ordinary provider retains its existing explicit model reselect default policy", async () => {
  const page = await browser.newPage();
  try {
    await ready(page, "theme=dark&locale=en-US&apiKey=1");
    await open(page);
    await page.getByTestId("composer-thought-slider").focus();
    await page.keyboard.press("End");
    await waitLevel(page, "high");
    await choose(page, "Alpha");
    await waitLevel(page, "medium");
  } finally {
    await page.close();
  }
});

test("shared single-level repair stays blocked while provider connection is pending", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}fixture?theme=dark&locale=en-US&sharedPending=1`);
    await open(page);
    const repair = page.getByTestId("composer-thought-repair");
    await repair.waitFor();
    assert.equal(await repair.getAttribute("aria-disabled"), "true");
    await repair.dispatchEvent("click");
    assert.equal(await page.evaluate(() => window.__brandPendingRepair.value), "");
    await page.evaluate(() => window.__brandPendingRepair.setPending(false));
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="composer-thought-repair"]')
          ?.getAttribute("aria-disabled") !== "true",
    );
    await repair.click();
    await page.waitForFunction(() => window.__brandPendingRepair.value === "low");
  } finally {
    await page.close();
  }
});

test("RUI03 invalid/missing and single-level selections need explicit repair; removed model keeps identity", async () => {
  const page = await browser.newPage();
  try {
    await ready(page);
    await page.evaluate(() =>
      window.__brandReasoning.changeCatalog("Alpha", ["low", "high"], "low"),
    );
    await open(page);
    await page.getByTestId("composer-thought-issue").waitFor();
    assert.equal(await level(page), "medium", "Removed effort remains the original draft intent");
    assert.equal(await page.getByTestId("accept").isDisabled(), true);
    await choose(page, "Alpha");
    assert.equal(
      await level(page),
      "medium",
      "Reselecting cannot silently repair a removed effort",
    );
    await page.evaluate(() => window.__brandReasoning.restore("Alpha", "retired"));
    await open(page);
    await page.getByTestId("composer-thought-issue").waitFor();
    assert.equal(await page.getByTestId("accept").isDisabled(), true);
    await choose(page, "Alpha");
    assert.equal(await level(page), "retired");
    await open(page);
    await page.getByTestId("composer-thought-slider").focus();
    await page.keyboard.press("Home");
    await waitLevel(page, "low");
    await page.evaluate(() => window.__brandReasoning.restore("Alpha"));
    await page.getByTestId("composer-thought-issue").waitFor();
    assert.equal(await page.getByTestId("accept").isDisabled(), true);
    await page.evaluate(() => window.__brandReasoning.changeCatalog("Alpha", ["medium"], "medium"));
    await page.getByTestId("composer-thought-repair").waitFor();
    assert.equal(await page.getByTestId("composer-thought-slider").count(), 0);
    await page.getByTestId("composer-thought-repair").click();
    await waitLevel(page, "medium");
    assert.equal(await page.getByTestId("composer-thought-issue").count(), 0);
    await page.evaluate(() => window.__brandReasoning.removeModel("Alpha"));
    await page
      .getByTestId("chat-model-select-trigger")
      .filter({ hasText: "Unavailable" })
      .waitFor();
    assert.equal(await page.getByTestId("accept").isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__brandReasoning.selection.modelId), "Alpha");
    await choose(page, "Fixed");
    await waitLevel(page, "low");
  } finally {
    await page.close();
  }
});

test("RUI04 none means upstream default and fixed model does not accept cycling shortcut", async () => {
  const page = await browser.newPage();
  try {
    await ready(page);
    await choose(page, "Auto");
    await waitLevel(page, "none");
    assert.match(
      await page.getByTestId("chat-model-select-trigger").innerText(),
      /Upstream default/,
    );
    await open(page);
    assert.equal(await page.getByTestId("composer-thought-slider").count(), 0);
    assert.equal(await page.getByTestId("composer-effort-shortcut").count(), 0);
    assert(!/\bOff\b|关闭/u.test(await page.getByRole("menu").innerText()));
    await close(page);
    await page.keyboard.press("Control+t");
    assert.equal(await level(page), "none");
  } finally {
    await page.close();
  }
});

for (const width of [390, 720, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["en-US", "zh-CN"]) {
      test(`RUI05 layout ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await ready(page, new URLSearchParams({ theme, locale }).toString());
          await choose(page, "Beta");
          await waitLevel(page, "xhigh");
          await open(page);
          const menu = page.getByRole("menu");
          await menu.evaluate(async (node) => {
            await Promise.allSettled(
              node.getAnimations({ subtree: true }).map((animation) => animation.finished),
            );
          });
          const box = await menu.boundingBox();
          assert(box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.match(
            await page.getByTestId("chat-model-select-trigger").innerText(),
            locale === "zh-CN" ? /极高/ : /Extra high/,
          );
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}.png`),
            animations: "disabled",
          });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
