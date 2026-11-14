import assert from "node:assert/strict";
import { test } from "node:test";

const reminderKey = "milocode-cua-application-reminder-v1";
const cachedStatusKey = "milocode-agent-desktop-permission-status-v1";
const currentApplication = {
  appName: "MiloCode",
  appVersion: "3.17.8",
  appPath: "/Applications/MiloCode.app",
  identity: "current-signed-build",
};
const grantedStatus = {
  provider: "agent-desktop",
  available: true,
  grantOwner: null,
  accessibility: "granted",
  screenRecording: "granted",
};

export function registerCuaApplicationReminderCases(getEnvironment) {
  async function openReminder({
    target = "mac",
    enabled = true,
    previous,
    freshGranted = false,
    cachedGranted = false,
    blockedStorage = false,
    application = currentApplication,
    context,
    configScope,
  } = {}) {
    const { browser, origin } = getEnvironment();
    const page = context ? await context.newPage() : await browser.newPage();
    const calls = [];
    const errors = [];
    let markApplicationReturned;
    const applicationReturned = new Promise((resolve) => {
      markApplicationReturned = resolve;
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(
      ({
        target,
        previous,
        cachedGranted,
        blockedStorage,
        reminderKey,
        cachedStatusKey,
        grantedStatus,
      }) => {
        if (target === "windows" || target === "linux") {
          Object.defineProperty(navigator, "userAgent", {
            configurable: true,
            value: target === "windows" ? "Mozilla/5.0 Windows NT 10.0" : "Mozilla/5.0 Linux",
          });
        }
        if (previous) localStorage.setItem(reminderKey, JSON.stringify(previous));
        if (cachedGranted)
          localStorage.setItem(
            cachedStatusKey,
            JSON.stringify({
              savedAt: Date.now(),
              status: grantedStatus,
            }),
          );
        if (blockedStorage) {
          const get = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            if (key === reminderKey) throw new DOMException("blocked", "SecurityError");
            return get.call(this, key);
          };
        }
      },
      {
        target,
        previous,
        cachedGranted,
        blockedStorage,
        reminderKey,
        cachedStatusKey,
        grantedStatus,
      },
    );
    await page.route("**/cua-rpc", async (route) => {
      const request = route.request().postDataJSON();
      calls.push(request);
      await route.fulfill({
        status: 200,
        body: JSON.stringify(
          request.action === "application-info"
            ? application
            : request.action === "status"
              ? grantedStatus
              : {},
        ),
      });
      if (request.action === "application-info") markApplicationReturned();
    });
    await page.goto(
      `${origin}fixture?${new URLSearchParams({
        cuaReminder: "true",
        computerUse: target,
        cuaEnabled: String(enabled),
        freshGranted: String(freshGranted),
        ...(configScope ? { configScope } : {}),
        locale: "en-US",
        theme: "light",
      })}`,
    );
    await page.getByTestId("reminder-ready").filter({ hasText: "true" }).waitFor();
    if (target === "mac") await applicationReturned;
    await page.bringToFront();
    return { page, calls, errors };
  }
  const checkButton = (page) =>
    page.getByRole("button", { name: "Check permissions", exact: true });
  async function waitForRecord(page, pending) {
    await page.waitForFunction(
      ({ key, pending, identity }) => {
        const record = JSON.parse(localStorage.getItem(key) ?? "null");
        return record?.identity === identity && record?.pending === pending;
      },
      { key: reminderKey, pending, identity: currentApplication.identity },
    );
  }
  function assertNoActiveOperations(calls) {
    assert.equal(
      calls.filter((call) =>
        ["list-plugins", "open-permission", "forbidden-restart", "status"].includes(call.action),
      ).length,
      0,
    );
  }

  test("CUA application first observation establishes a silent baseline", async () => {
    const { page, calls, errors } = await openReminder();
    try {
      await waitForRecord(page, false);
      assert.equal(await checkButton(page).count(), 0);
      assertNoActiveOperations(calls);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("CUA application changed identity reminds once and navigates to Computer Use settings", async () => {
    const { page, calls, errors } = await openReminder({
      previous: { identity: "old-build", pending: false },
    });
    try {
      await checkButton(page).waitFor();
      await waitForRecord(page, false);
      await page.evaluate(() => window.__setReminderMounted(false));
      await page.evaluate(() => window.__setReminderMounted(true));
      await checkButton(page).click();
      await page.getByTestId("reminder-active-tab").filter({ hasText: "__settings__" }).waitFor();
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem("zcode-settings-section-intent")),
        "computerUse",
      );
      assertNoActiveOperations(calls);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("CUA application current identity does not repeatedly remind", async () => {
    const { page, calls } = await openReminder({
      previous: { identity: currentApplication.identity, pending: false },
    });
    try {
      await waitForRecord(page, false);
      assert.equal(await checkButton(page).count(), 0);
      assertNoActiveOperations(calls);
    } finally {
      await page.close();
    }
  });
  test("CUA application confirmed fresh permissions consume reminder silently", async () => {
    const { page, calls, errors } = await openReminder({
      previous: { identity: "old-build", pending: false },
      freshGranted: true,
    });
    try {
      await waitForRecord(page, false);
      assert.equal(await checkButton(page).count(), 0);
      assert.equal(calls.filter((call) => call.action === "status").length, 1);
      assert.equal(calls.filter((call) => call.action === "open-permission").length, 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("CUA application cached old granted status cannot suppress a new identity reminder", async () => {
    const { page, calls } = await openReminder({
      previous: { identity: "old-build", pending: false },
      cachedGranted: true,
    });
    try {
      await checkButton(page).waitFor();
      await waitForRecord(page, false);
      assertNoActiveOperations(calls);
    } finally {
      await page.close();
    }
  });
  test("CUA application disabled plugin keeps pending reminder until explicitly enabled", async () => {
    const { page, calls } = await openReminder({
      enabled: false,
      previous: { identity: "old-build", pending: false },
    });
    try {
      await waitForRecord(page, true);
      assert.equal(await checkButton(page).count(), 0);
      await page.evaluate(() => window.__setReminderPluginEnabled(true));
      await checkButton(page).waitFor();
      await waitForRecord(page, false);
      assertNoActiveOperations(calls);
    } finally {
      await page.close();
    }
  });
  test("CUA application user-scope enablement cannot consume a workspace reminder", async () => {
    const { page, calls } = await openReminder({
      configScope: "user",
      previous: { identity: "old-build", pending: false },
    });
    try {
      await waitForRecord(page, true);
      assert.equal(await checkButton(page).count(), 0);
      await page.evaluate(() => window.__setReminderEffectiveScope());
      await checkButton(page).waitFor();
      await waitForRecord(page, false);
      assertNoActiveOperations(calls);
    } finally {
      await page.close();
    }
  });
  for (const target of ["remote", "windows", "linux", "web"]) {
    test(`CUA application ${target} never queries Mac metadata or prompts`, async () => {
      const { page, calls, errors } = await openReminder({
        target,
        previous: { identity: "old-build", pending: false },
      });
      try {
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.equal(await checkButton(page).count(), 0);
        assert.equal(calls.length, 0);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
  test("CUA application unavailable signing identity does not guess an update", async () => {
    const { page, calls, errors } = await openReminder({
      previous: { identity: "old-build", pending: false },
      application: { ...currentApplication, identity: null },
    });
    try {
      assert.equal(await checkButton(page).count(), 0);
      assert.deepEqual(
        await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reminderKey),
        { identity: "old-build", pending: false },
      );
      assertNoActiveOperations(calls);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("CUA application inaccessible local storage does not break the app or repeatedly prompt", async () => {
    const { page, calls, errors } = await openReminder({ blockedStorage: true });
    try {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await checkButton(page).count(), 0);
      assertNoActiveOperations(calls);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("CUA application two windows share one reminder claim", async () => {
    const { browser } = getEnvironment();
    const context = await browser.newContext();
    try {
      const seed = await openReminder({ context, target: "remote" });
      await seed.page.evaluate(
        ({ key }) =>
          localStorage.setItem(key, JSON.stringify({ identity: "old-build", pending: false })),
        { key: reminderKey },
      );
      await seed.page.close();
      const windows = await Promise.all([openReminder({ context }), openReminder({ context })]);
      await Promise.all(windows.map(({ page }) => waitForRecord(page, false)));
      assert.equal(
        (await Promise.all(windows.map(({ page }) => checkButton(page).count()))).reduce(
          (count, next) => count + next,
          0,
        ),
        1,
      );
      for (const { calls, errors } of windows) {
        assertNoActiveOperations(calls);
        assert.deepEqual(errors, []);
      }
    } finally {
      await context.close();
    }
  });
}
