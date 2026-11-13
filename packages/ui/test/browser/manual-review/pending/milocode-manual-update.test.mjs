import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/milocode-manual-update.fixture.tsx";
let server, browser, origin;
before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "manual-update-fixture",
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

test("a cancelled Main installation unlocks the controller without duplicate confirmation", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?surface=controller&locale=zh-CN`);
    const install = page.getByRole("button", {
      name: "重启以更新",
      exact: true,
    });
    await install.click();
    assert.equal(await install.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__updateActions), [
      "install",
    ]);
    await page.evaluate(() => window.__resolveUpdateInstall());
    // 第二次点击会等待真实 React 状态恢复，无超时兜底或乐观重置。
    await install.click();
    assert.deepEqual(await page.evaluate(() => window.__updateActions), [
      "install",
      "install",
    ]);
    await page.evaluate(() => window.__resolveUpdateInstall());
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

for (const locale of ["en-US", "zh-CN"]) {
  test(`manual stable policy retains hardware acceleration (${locale})`, async () => {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    try {
      await page.goto(`${origin}fixture?surface=settings&locale=${locale}`);
      const hardware = page.getByRole("switch", {
        name:
          locale === "zh-CN"
            ? "Chrome 硬件加速"
            : "Chrome hardware acceleration",
        exact: true,
      });
      await hardware.waitFor();
      assert.equal(
        await page
          .getByRole("switch", {
            name: /preview|预览|自动下载|Automatically download/i,
          })
          .count(),
        0,
      );
      await hardware.click();
      assert.deepEqual(await page.evaluate(() => window.__updateActions), [
        "hardware",
      ]);
    } finally {
      await page.close();
    }
  });
}

for (const [phase, action, label] of [
  ["before-download", "download", /下载更新|Download update/i],
  ["downloading", "cancel", /取消下载|Cancel download/i],
  ["downloaded", "install", /重启.*更新|Restart.*update/i],
])
  for (const width of [390, 1200])
    for (const theme of ["light", "dark"]) {
      test(`explicit update action ${phase}/${width}/${theme}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(
            `${origin}fixture?phase=${phase}&theme=${theme}&locale=zh-CN`,
          );
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          assert.equal(await dialog.getByRole("checkbox").count(), 0);
          assert.deepEqual(
            await page.evaluate(() => window.__updateActions),
            [],
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          await dialog.getByRole("button", { name: label }).click();
          assert.deepEqual(await page.evaluate(() => window.__updateActions), [
            action,
          ]);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }

test("pending manual update actions cannot be submitted again", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(
      `${origin}fixture?phase=before-download&pending=1&locale=zh-CN`,
    );
    const buttons = page.getByRole("dialog").getByRole("button");
    await buttons.first().waitFor();
    for (const button of await buttons.all()) {
      // Dialog 的关闭图标保持可用；真正的更新动作在等待期间锁定。
      if ((await button.getAttribute("data-slot")) === "dialog-close") continue;
      if ((await button.innerText()).trim())
        assert.equal(await button.isDisabled(), true);
    }
    assert.deepEqual(await page.evaluate(() => window.__updateActions), []);
  } finally {
    await page.close();
  }
});
