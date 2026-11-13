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
const entry = "/packages/ui/test/browser/manual-review/pending/brand-browser-login.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/brand-browser-login");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "browser-login-fixture",
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

test("failure to open the browser cancels the waiting attempt", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.goto(`${origin}fixture?theme=light&locale=zh-CN&failOpen=1`);
    const start = page.getByTestId("brand-account-submit");
    await start.click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByTestId("brand-account-cancel-browser").count(), 0);
    assert.equal(await start.isEnabled(), true);
  } finally {
    await page.close();
  }
});

for (const failure of ["failStorage", "initializationError"]) {
  test(`login keeps the safe storage reason visible after ${failure}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.goto(
        `${origin}fixture?theme=dark&locale=zh-CN&${failure}=1${failure === "failStorage" ? "&embedded=1" : ""}`,
      );
      if (failure === "failStorage") await page.getByTestId("brand-account-submit").click();
      const retry = page.getByRole("button", { name: "重试", exact: true });
      await retry.waitFor();
      const alert = page.getByRole("alert");
      await alert.waitFor();
      assert.match(await alert.innerText(), /系统安全存储/u);
      const text = await page.locator("body").innerText();
      assert(!text.includes("UNTRUSTED_INTERNAL_SECRET"));
      assert(!text.includes("暂时无法加载账号服务"));
      await page.screenshot({ path: join(artifacts, `${failure}-storage-error.png`) });
      await retry.click();
      assert.deepEqual(await page.evaluate(() => window.__brandInferenceActions), ["initialize"]);
    } finally {
      await page.close();
    }
  });
}

for (const [reason, expected, action] of [
  ["credential_disabled", "停用", null],
  ["credential_expired", "过期", null],
  ["credential_quota_exhausted", "额度已用完", null],
  ["group_forbidden", "无权", null],
  ["network", "检查网络", "refresh"],
  ["reauthentication_required", "重新登录", "logout"],
  ["constructor", "操作未完成", "refresh"],
]) {
  test(`inference recovery explains ${reason} and offers the appropriate action`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    try {
      await page.goto(`${origin}fixture?surface=status&theme=light&locale=zh-CN&reason=${reason}`);
      await page.getByTestId("brand-inference-status").waitFor();
      assert((await page.locator("body").innerText()).includes(expected));
      assert(!(await page.locator("body").innerText()).includes("UNTRUSTED_INTERNAL_SECRET"));
      const buttons = page.getByRole("button");
      assert.equal(await buttons.count(), action ? 1 : 0);
      if (action) {
        await buttons.click();
        await page.waitForFunction(() => window.__brandInferenceActions.length > 0);
        assert.deepEqual(await page.evaluate(() => window.__brandInferenceActions), [action]);
        if (action === "logout") {
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="fixture-settings-tabs"]')?.textContent === "1",
          );
          assert((await page.getByTestId("brand-inference-status").innerText()).includes("请登录"));
        }
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    } finally {
      await page.close();
    }
  });
}

for (const accountStatus of ["signedOut", "expired"]) {
  test(`local browsing ${accountStatus} retains a sign-in recovery entry`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    try {
      await page.goto(
        `${origin}fixture?surface=status&locale=zh-CN&accountStatus=${accountStatus}`,
      );
      const status = page.getByTestId("brand-inference-status");
      await status.waitFor();
      assert.match(await status.innerText(), accountStatus === "expired" ? /过期/u : /请登录/u);
      await page.getByRole("button").click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="fixture-settings-tabs"]')?.textContent === "1",
      );
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem("zcode-settings-section-intent")),
        "account",
      );
    } finally {
      await page.close();
    }
  });
}

test("a failed model sync preserves its timestamp and explains the safe reason", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  try {
    await page.goto(`${origin}fixture?surface=sync&theme=dark&locale=en-US&reason=network`);
    const status = page.getByTestId("brand-model-sync-status");
    await status.waitFor();
    assert.equal(await status.getAttribute("data-sync-state"), "failed");
    assert.equal(await status.getAttribute("data-last-successful-at"), "1794500000000");
    const text = await status.innerText();
    assert.match(text, /network|connection|connect/iu);
    assert(!text.includes("UNTRUSTED_INTERNAL_SECRET"));
  } finally {
    await page.close();
  }
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["en-US", "zh-CN"]) {
      test(`browser login ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          const start = page.getByTestId("brand-account-submit");
          await start.waitFor();
          assert.equal(await page.locator('input[type="password"]').count(), 0);
          assert.equal(await start.isEnabled(), true, "Captcha must be handled by website");
          assert.equal(
            await start.innerText(),
            locale === "zh-CN" ? "在浏览器登录" : "Sign in with browser",
          );
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}-idle.png`) });
          await start.click();
          await page.getByTestId("brand-account-cancel-browser").waitFor();
          assert.equal(await start.isDisabled(), true);
          assert.deepEqual(await page.evaluate(() => window.__browserLoginOpened), [
            "https://fixture.example.test/desktop/authorize?client_id=zcode-desktop",
          ]);
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-waiting.png`),
          });
          await page.getByTestId("brand-account-cancel-browser").click();
          await page.getByTestId("brand-account-cancel-browser").waitFor({ state: "detached" });
          assert.equal(await start.isEnabled(), true);
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
