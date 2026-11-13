import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateMiloCodeUpdatePolicy } from "../packages/desktop/scripts/milocode-release-trust.mjs";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）> 关闭。
 * 规则见 docs/desktop/build-time-optional-capabilities.md。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  const defaults = await readPrivateDefaults(defaultsPath);
  const baseUrl = pickValue(env, defaults, "MILOCODE_UPDATE_BASE_URL");
  const publicKeysJson = pickValue(env, defaults, "MILOCODE_UPDATE_PUBLIC_KEYS_JSON");
  const sparklePublicKey = pickValue(env, defaults, "MILOCODE_SPARKLE_PUBLIC_KEY");
  // 正式更新源只在构建时授权，不能把运行环境或登录深链当作发布授权。
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("MILOCODE_UPDATE_BASE_URL 必须是没有凭据、查询和片段的 HTTPS 地址");
    }
    const keys = JSON.parse(publicKeysJson || "{}");
    if (
      !keys ||
      Array.isArray(keys) ||
      typeof keys !== "object" ||
      Object.values(keys).some(
        (pem) => typeof pem !== "string" || !pem.startsWith("-----BEGIN PUBLIC KEY-----"),
      )
    ) {
      throw new Error("MiloCode 更新公钥必须为 Ed25519 SPKI 公钥，不能嵌入私钥");
    }
    validateMiloCodeUpdatePolicy({
      manifestUrl: new URL("stable/win32-x64/latest.json", `${baseUrl.replace(/\/+$/, "")}/`).href,
      releaseBaseUrl: `${baseUrl.replace(/\/+$/, "")}/`,
      publicKeys: keys,
      productId: "app.milo.code",
      platform: "win32-x64",
    });
  } else if (publicKeysJson || sparklePublicKey) {
    throw new Error("MiloCode 更新公钥需要同时配置 MILOCODE_UPDATE_BASE_URL");
  }
  if (sparklePublicKey && !/^[A-Za-z0-9+/]{43}=$/.test(sparklePublicKey)) {
    throw new Error("MILOCODE_SPARKLE_PUBLIC_KEY 必须是 Sparkle 生成的 32 字节 Base64 公钥");
  }
  return {
    armsRumEndpoint: pickValue(env, defaults, "ZCODE_ARMS_RUM_ENDPOINT"),
    telemetryReportEndpoint: pickValue(env, defaults, "ZCODE_TELEMETRY_REPORT_ENDPOINT"),
    autoUpdateEnabled: ENABLED_VALUES.has(
      pickValue(env, defaults, "ZCODE_AUTO_UPDATE").toLowerCase(),
    ),
    milocodeUpdateBaseUrl: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/` : "",
    milocodeUpdatePublicKeysJson: publicKeysJson || "{}",
    milocodeSparklePublicKey: sparklePublicKey,
  };
}

export function createBuildTimeConfigDefines(config) {
  return {
    __ZCODE_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __ZCODE_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
    __MILOCODE_UPDATE_BASE_URL__: JSON.stringify(config.milocodeUpdateBaseUrl ?? ""),
    __MILOCODE_UPDATE_PUBLIC_KEYS_JSON__: JSON.stringify(
      config.milocodeUpdatePublicKeysJson ?? "{}",
    ),
    __MILOCODE_SPARKLE_PUBLIC_KEY__: JSON.stringify(config.milocodeSparklePublicKey ?? ""),
  };
}
