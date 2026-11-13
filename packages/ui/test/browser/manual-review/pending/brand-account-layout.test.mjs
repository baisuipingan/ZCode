// 账号布局浏览器验收，使用真实React组件与合成服务，无生产请求。
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
const entry = "/packages/ui/test/browser/manual-review/pending/brand-account-layout.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/brand-account-layout");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "brand-account-layout-fixture",
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
      watch: {
        ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"],
      },
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

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["en-US", "zh-CN"]) {
      test(`account layout ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          const summary = page.getByTestId("brand-account-summary");
          await summary.waitFor();
          assert.ok(
            (await summary.boundingBox()).height <= 90,
            "normal sidebar summary must remain two compact rows",
          );
          assert.equal(await page.getByTestId("brand-inference-status").count(), 0);
          assert.equal(await page.getByTestId("brand-account-overview").count(), 1);
          const usageTab = page.getByTestId("brand-account-tab-usage");
          const ordersTab = page.getByTestId("brand-account-tab-orders");
          assert.equal(await usageTab.getAttribute("aria-selected"), "true");
          assert.equal(await page.getByTestId("brand-usage-row").count(), 1);
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-usage.png`),
          });
          const baseline = await page.evaluate(() => ({
            ...window.__brandLayoutCalls,
          }));
          await summary.getByTestId("brand-account-refresh").click();
          assert.equal(
            await page.evaluate(() => window.__brandLayoutCalls.balance),
            baseline.balance + 1,
          );
          await summary.getByTestId("brand-account-recharge").click();
          assert.deepEqual(await page.evaluate(() => window.__brandLayoutCalls.recharge), [
            undefined,
          ]);
          await usageTab.focus();
          await page.keyboard.press("ArrowRight");
          await page.getByTestId("brand-order-1").waitFor();
          assert.equal(await ordersTab.getAttribute("aria-selected"), "true");
          assert.equal(
            await page.evaluate(() => window.__brandLayoutCalls.orders),
            baseline.orders,
            "switching records must not create another request path",
          );
          await page.getByTestId("brand-order-1").click();
          assert.deepEqual(await page.evaluate(() => window.__brandLayoutCalls.recharge), [
            undefined,
            1,
          ]);
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-orders.png`),
          });
          await page.getByTestId("fixture-stale-wallet").click();
          await summary.getByTestId("brand-account-wallet-warning").waitFor();
          assert.match(await summary.getByTestId("brand-account-balance").innerText(), /12\.34/);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }

test("wallet reauthentication opens account settings after logout from sidebar and overview", async () => {
  for (const surface of ["brand-account-summary", "brand-account-overview"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.goto(`${origin}fixture?theme=dark&locale=zh-CN`);
      await page.getByTestId("fixture-wallet-reauthenticate").click();
      await page
        .getByTestId(surface)
        .getByRole("button", { name: "重新登录", exact: true })
        .click();
      await page.getByTestId("brand-account-login").waitFor();
      assert.equal(await page.evaluate(() => window.__brandLayoutCalls.logout), 1);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="fixture-settings-tabs"]')?.textContent === "1",
        undefined,
        { timeout: 1500 },
      );
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem("zcode-settings-section-intent")),
        "account",
      );
    } finally {
      await page.close();
    }
  }
});

test("late old-account orders do not replace current account records", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  try {
    await page.goto(`${origin}fixture?theme=dark&locale=zh-CN&gateOrder=1`);
    await page.waitForFunction(() => typeof window.__releaseBrandOrder === "function");
    await page.getByTestId("fixture-switch-account").click();
    await page.getByTestId("brand-account-tab-orders").click();
    await page.getByTestId("brand-order-2").waitFor();
    await page.evaluate(() => window.__releaseBrandOrder());
    assert.equal(await page.getByTestId("brand-order-1").count(), 0);
    assert.match(await page.getByTestId("brand-account-overview").innerText(), /Second account/);
  } finally {
    await page.close();
  }
});

for (const width of [390, 1200])
  test(`embedded browser login ${width}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(`${origin}fixture?theme=dark&locale=zh-CN&signedOut=1`);
      const login = page.getByTestId("brand-account-login");
      await login.waitFor();
      assert.equal(await login.getAttribute("data-layout"), "embedded");
      assert.equal(await login.locator("main").count(), 0);
      assert.ok(
        (await login.boundingBox()).height < 650,
        "embedded login must not add a viewport of empty space",
      );
      await page.getByTestId("brand-account-submit").click();
      await page.getByTestId("brand-account-cancel-browser").waitFor();
      await page.getByTestId("brand-account-cancel-browser").click();
      await page.getByTestId("brand-account-cancel-browser").waitFor({ state: "detached" });
      assert.equal(await page.getByTestId("brand-account-submit").isEnabled(), true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: join(artifacts, `${width}-dark-zh-CN-embedded-login.png`),
      });
    } finally {
      await page.close();
    }
  });
