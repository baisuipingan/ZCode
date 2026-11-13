import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createBuildTimeConfigDefines, resolveBuildTimeConfig } from "../build-time-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "zcode-build-time-config-"));
const disabledMiloCode = {
  milocodeUpdateBaseUrl: "",
  milocodeUpdatePublicKeysJson: "{}",
  milocodeSparklePublicKey: "",
};
after(() => rm(dir, { recursive: true, force: true }));

async function writeDefaults(name, content) {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("没有私有默认配置也没有环境变量时三项能力都关闭", async () => {
  const config = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
    ...disabledMiloCode,
  });
});

test("私有默认配置启用三项能力", async () => {
  const defaultsPath = await writeDefaults("defaults.json", {
    ZCODE_ARMS_RUM_ENDPOINT: " https://rum.example.com/x ",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "1",
  });
  assert.deepEqual(await resolveBuildTimeConfig({}, { defaultsPath }), {
    armsRumEndpoint: "https://rum.example.com/x",
    telemetryReportEndpoint: "https://report.example.com/event",
    autoUpdateEnabled: true,
    ...disabledMiloCode,
  });
});

test("环境变量优先于私有默认配置，显式空字符串关闭单项能力", async () => {
  const defaultsPath = await writeDefaults("override.json", {
    ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "true",
  });
  const config = await resolveBuildTimeConfig(
    {
      ZCODE_ARMS_RUM_ENDPOINT: "",
      ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://other.example.com/event",
      ZCODE_AUTO_UPDATE: "0",
    },
    { defaultsPath },
  );
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "https://other.example.com/event",
    autoUpdateEnabled: false,
    ...disabledMiloCode,
  });
});

test("私有默认配置格式错误时直接报错，不静默关闭", async () => {
  const defaultsPath = await writeDefaults("broken.json", "[1]");
  await assert.rejects(resolveBuildTimeConfig({}, { defaultsPath }), /必须是 JSON 对象/);
});

test("define 以 JSON 字面量注入", () => {
  assert.deepEqual(
    createBuildTimeConfigDefines({
      armsRumEndpoint: "https://rum.example.com/x",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: true,
    }),
    {
      __ZCODE_ARMS_RUM_ENDPOINT__: '"https://rum.example.com/x"',
      __ZCODE_TELEMETRY_REPORT_ENDPOINT__: '""',
      __ZCODE_AUTO_UPDATE_ENABLED__: "true",
      __MILOCODE_UPDATE_BASE_URL__: '""',
      __MILOCODE_UPDATE_PUBLIC_KEYS_JSON__: '"{}"',
      __MILOCODE_SPARKLE_PUBLIC_KEY__: '""',
    },
  );
});

test("MiloCode 发布源必须同时绑定 Ed25519 公钥且不能包含凭据或查询", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = JSON.stringify({ release1: publicKey.export({ type: "spki", format: "pem" }) });
  const options = { defaultsPath: join(dir, "missing.json") };
  const config = await resolveBuildTimeConfig(
    {
      MILOCODE_UPDATE_BASE_URL: "https://downloads.example.com/milocode",
      MILOCODE_UPDATE_PUBLIC_KEYS_JSON: keys,
    },
    options,
  );
  assert.equal(config.milocodeUpdateBaseUrl, "https://downloads.example.com/milocode/");
  assert.equal(config.milocodeUpdatePublicKeysJson, keys);
  for (const base of [
    "http://downloads.example.com",
    "https://u:p@downloads.example.com",
    "https://downloads.example.com/?x=1",
  ]) {
    await assert.rejects(
      resolveBuildTimeConfig(
        { MILOCODE_UPDATE_BASE_URL: base, MILOCODE_UPDATE_PUBLIC_KEYS_JSON: keys },
        options,
      ),
    );
  }
  await assert.rejects(
    resolveBuildTimeConfig({ MILOCODE_UPDATE_BASE_URL: "https://downloads.example.com" }, options),
  );
  await assert.rejects(resolveBuildTimeConfig({ MILOCODE_UPDATE_PUBLIC_KEYS_JSON: keys }, options));
  await assert.rejects(
    resolveBuildTimeConfig(
      {
        MILOCODE_UPDATE_BASE_URL: "https://downloads.example.com",
        MILOCODE_UPDATE_PUBLIC_KEYS_JSON: JSON.stringify({
          release1: privateKey.export({ type: "pkcs8", format: "pem" }),
        }),
      },
      options,
    ),
  );
});
