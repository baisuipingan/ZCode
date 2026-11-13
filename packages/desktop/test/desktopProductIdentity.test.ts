import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  desktopProductIdentities,
  resolveDesktopArtifactSuffix,
  resolveDesktopProductFlavor,
  resolveWindowsAppUserModelId,
  resolveWindowsAppUserModelIdForFlavor,
  resolveDesktopProductIdentity,
} from "../scripts/desktop-product-identity.mjs";

const runtimeIdentity = vi.hoisted(() => ({ isPackaged: true, flavor: "production" }));
vi.mock("../src/main/desktopElectronApp.js", () => ({
  isElectronAppPackaged: () => runtimeIdentity.isPackaged,
  getElectronAppPath: () => "/fixture/electron-app-data",
}));
vi.mock("@zcode/services/node", () => ({
  getAppConfigDir: () => "/fixture/business/.zcode",
  getDataBaseDir: () => "/fixture/business",
  listSSHConfigAliasesFromLocalConfig: () => [],
}));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZCODE_PRODUCT_FLAVOR() {
    return runtimeIdentity.flavor;
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function readRuntimeIdentity(options: {
  flavor: "production" | "preview";
  isPackaged?: boolean;
  applicationName?: string;
}) {
  runtimeIdentity.flavor = options.flavor;
  runtimeIdentity.isPackaged = options.isPackaged ?? true;
  vi.stubEnv("ZCODE_DESKTOP_APPLICATION_NAME", options.applicationName ?? "");
  vi.stubEnv("ZCODE_DESKTOP_USER_DATA_DIR", "");
  vi.stubEnv("ZCODE_DESKTOP_SESSION_DATA_DIR", "");
  vi.stubEnv("ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA", "");
  return import("../src/main/desktopRuntimeEnv.js");
}

describe("desktop product identity", () => {
  it.each(["production", "preview"] as const)(
    "已打包 %s 的运行名称和Electron默认数据目录复用产品身份",
    async (flavor) => {
      const runtime = await readRuntimeIdentity({ flavor });
      const productName = desktopProductIdentities[flavor].productName;
      expect(runtime.runtimeApplicationName).toBe(productName);
      expect(runtime.runtimeUserDataPath).toBe(join("/fixture/electron-app-data", productName));
      expect(runtime.runtimeSessionDataPath).toBe(
        join("/fixture/electron-app-data", productName, "session"),
      );
    },
  );

  it("开发态保留ZCode Dev，不借用正式安装身份", async () => {
    const runtime = await readRuntimeIdentity({ flavor: "production", isPackaged: false });
    expect(runtime.runtimeApplicationName).toBe("ZCode Dev");
  });

  it("显式隔离名称仍优先，空白覆盖回到编译身份", async () => {
    const runtime = await readRuntimeIdentity({
      flavor: "preview",
      applicationName: "  E2E isolated desktop  ",
    });
    expect(runtime.runtimeApplicationName).toBe("E2E isolated desktop");
    expect(runtime.runtimeUserDataPath).toBe(
      join("/fixture/electron-app-data", "E2E isolated desktop"),
    );
    vi.resetModules();
    const fallback = await readRuntimeIdentity({ flavor: "preview", applicationName: "  " });
    expect(fallback.runtimeApplicationName).toBe("MiloCode Preview");
  });

  it("根锁文件的发布版本与构建版本一致", () => {
    // 合并上游发布提交只对齐当前版本，不恢复上游旧版本，也不重算依赖锁。
    const readRootJson = (name: string) =>
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../../..", name), "utf8"));
    const version = readRootJson("package.json").version;
    const lock = readRootJson("package-lock.json");
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
  });

  it("ZCODE_ENV=test 使用可与生产版并排安装的 Preview 身份", () => {
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "test" })).toEqual({
      flavor: "preview",
      appId: "app.milo.code.preview",
      productName: "MiloCode Preview",
      linuxExecutableName: "milocode-preview",
      linuxPackageName: "milocode-preview",
      cuaHelperInstallVariant: "preview",
    });
  });

  it("ZCODE_PREVIEW_IDENTITY=1 让生产后端的构建改用 Preview 身份", () => {
    // 身份与后端环境分轴：同一份 Preview 身份既可以连测试后端，也可以连生产后端。
    for (const flag of ["1", " 1 "]) {
      const env = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag };
      expect(resolveDesktopProductFlavor(env)).toBe("preview");
      expect(resolveDesktopProductIdentity(env)).toBe(desktopProductIdentities.preview);
    }
    for (const flag of ["", "0"]) {
      const env = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag };
      expect(resolveDesktopProductFlavor(env)).toBe("production");
    }
  });

  it("开关只认 1/0：其它拼写在构建期直接失败，不能在路由层漏匹配却在脚本层开启", () => {
    // CI workflow 规则与 release 门做 == "1" 精确比较；若脚本层再接受 true/yes/on，
    // `ZCODE_PREVIEW_IDENTITY=true` 会落入 @electron/dev 生产验收目录却打出 Preview 身份包。
    for (const flag of ["true", "yes", "on", "false", "no", "off", "2"]) {
      expect(() =>
        resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag }),
      ).toThrow(/expected 1 or 0/);
    }
  });

  it("测试后端永远是 Preview 身份，开关无法把它变成正式 MiloCode", () => {
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_PREVIEW_IDENTITY: "0" })).toBe(
      "preview",
    );
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_PREVIEW_IDENTITY: "1" })).toBe(
      "preview",
    );
  });

  it("产物后缀只标记后端环境，生产后端的 Preview 包靠 productName 区分", () => {
    expect(resolveDesktopArtifactSuffix({ ZCODE_ENV: "test" })).toBe("_TEST");
    expect(resolveDesktopArtifactSuffix({ ZCODE_ENV: "production" })).toBe("");
    expect(
      resolveDesktopArtifactSuffix({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe("");
    expect(resolveDesktopArtifactSuffix({})).toBe("_TEST");
  });

  it("ZCODE_ENV=production 完整保留正式包身份", () => {
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "production" })).toBe(
      desktopProductIdentities.production,
    );
    expect(desktopProductIdentities.production).toEqual({
      flavor: "production",
      appId: "app.milo.code",
      productName: "MiloCode",
      linuxExecutableName: "milocode",
      linuxPackageName: "milocode",
      cuaHelperInstallVariant: null,
    });
  });

  it("未注入或未知环境时不应误生成正式安装身份", () => {
    expect(resolveDesktopProductIdentity({}).flavor).toBe("preview");
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "staging" }).flavor).toBe("preview");
  });

  it("打包态 Windows AUMID 必须和 NSIS appId 保持一致", () => {
    expect(resolveWindowsAppUserModelId({ ZCODE_ENV: "production" })).toBe(
      desktopProductIdentities.production.appId,
    );
    expect(resolveWindowsAppUserModelId({ ZCODE_ENV: "test" })).toBe(
      desktopProductIdentities.preview.appId,
    );
    expect(
      resolveWindowsAppUserModelId({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe(desktopProductIdentities.preview.appId);
    // 主进程按编译期 flavor 取 AUMID，不依赖安装后机器上的环境变量。
    expect(resolveWindowsAppUserModelIdForFlavor("preview")).toBe(
      desktopProductIdentities.preview.appId,
    );
    expect(resolveWindowsAppUserModelIdForFlavor("production")).toBe(
      desktopProductIdentities.production.appId,
    );
  });

  it("开发态继续使用独立 AUMID，避免污染打包版 Shell 身份", () => {
    expect(resolveWindowsAppUserModelId({}, { isPackaged: false })).toBe("app.milo.code.dev");
  });
});
