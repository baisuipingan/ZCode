// 真实桌面 HTML 首屏→真实 React loading 的品牌交接浏览器回归，无生产请求。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/brand-startup-logo.fixture.tsx";
const htmlPath = "/packages/desktop/src/renderer/index.html";
const artifacts = join(root, "output/playwright/brand-startup-logo");
const asset = await readFile(join(root, "packages/ui/src/assets/milo-logo.png"));
const assetSha = createHash("sha256").update(asset).digest("hex");
let server, browser, origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "brand-startup-logo-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith(htmlPath) || req.url.includes("html-proxy")) return next();
            const html = (await readFile(join(root, htmlPath), "utf8")).replace(
              '<script type="module" src="./src/main.tsx"></script>',
              `<script type="module" src="${entry}"></script>`,
            );
            res.setHeader("Content-Type", "text/html");
            res.end(await vite.transformIndexHtml(req.url, html));
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
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

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`static and React startup share MiloCode asset (${reducedMotion})`, async () => {
    const page = await browser.newPage({ reducedMotion });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      // 不等待 module/load：首轮依赖编译可能超过 HTML 自带的3秒故障逃生窗口。
      // 这里先验收真正的首帧，再等待 React fixture 就绪，保留产品的原降级时序。
      await page.goto(`${origin}${htmlPath.slice(1)}`, { waitUntil: "commit" });
      await page.locator("#loading").waitFor({ state: "visible" });
      const staticLogo = page.locator("#loading img.startup-logo");
      assert.equal(await staticLogo.count(), 1, "pre-React shell must show the brand image");
      assert.equal(await page.locator("#loading svg").count(), 0, "old ZCode SVG must not flash");
      assert.equal(await page.title(), "MiloCode");
      await staticLogo.evaluate((img) => img.decode());
      assert.equal(await staticLogo.evaluate((img) => img.naturalWidth > 0), true);
      const staticUrl = await staticLogo.getAttribute("src");
      const staticAsset = await page.request.get(new URL(staticUrl, page.url()).href);
      assert.equal(
        createHash("sha256")
          .update(await staticAsset.body())
          .digest("hex"),
        assetSha,
      );
      assert.equal(await page.locator("#loading").isVisible(), true);
      await page.screenshot({ path: join(artifacts, `static-${reducedMotion}.png`) });
      await page.waitForFunction(() => typeof window.renderStartupFixture === "function");
      await page.evaluate(() => window.renderStartupFixture());
      const reactLogo = page.getByTestId("root-startup-loading").locator("img");
      await reactLogo.waitFor();
      await reactLogo.evaluate((img) => img.decode());
      const reactAsset = await page.request.get(
        new URL(await reactLogo.getAttribute("src"), page.url()).href,
      );
      assert.equal(
        createHash("sha256")
          .update(await reactAsset.body())
          .digest("hex"),
        assetSha,
      );
      await page.locator("#loading").waitFor({ state: "detached" });
      assert.equal(await page.locator("body.zcode-startup-ready").count(), 1);
      await page.screenshot({ path: join(artifacts, `react-${reducedMotion}.png`) });
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failed-${reducedMotion}.png`) });
      console.error({
        error: String(error),
        pageErrors: errors,
        html: await page.locator("body").innerHTML(),
      });
      throw error;
    } finally {
      await page.close();
    }
  });
}

test("update-status entry never shows the main startup shell", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}${htmlPath.slice(1)}?windowKind=update-status`);
    await page.waitForFunction(() => typeof window.renderStartupFixture === "function");
    assert.equal(await page.locator("#loading").count(), 0);
    assert.equal(await page.locator("body.zcode-startup-ready").count(), 1);
  } finally {
    await page.close();
  }
});
