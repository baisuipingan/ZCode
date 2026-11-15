import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReleaseKeys } from "./milocode-release-keys.mjs";
import { runReleaseCli } from "./milocode-release.mjs";
import { prepareRelease, validateReleasePlan, publishRelease } from "./milocode-release-stage.mjs";
import { createS3Client, signS3Request } from "./milocode-release-s3.mjs";

const runFile = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "milocode-publish-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installer = join(dir, "input.exe");
  const blockmap = `${installer}.blockmap`;
  await writeFile(installer, "test NSIS payload");
  await writeFile(blockmap, "test block map");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = join(dir, "test-signing.pem");
  await writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  return {
    dir,
    publicKey,
    options: {
      version: "3.17.3",
      baseUrl: "https://download.example.com/milocode/",
      outputDir: join(dir, "release"),
      releaseDate: "2026-11-13T00:00:00.000Z",
      windows: { installer, blockmap, keyId: "test-2026", privateKeyFile },
    },
  };
}

test("release keys are private and existing keys are never replaced", async (t) => {
  const { dir } = await fixture(t);
  const keyDir = join(dir, "keys");
  const result = await createReleaseKeys({ keyId: "release-test", keyDir });
  const before = await readFile(result.privateKeyFile);
  assert.match(result.publicKeysJson, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE KEY/);
  assert.equal((await stat(result.privateKeyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(keyDir)).mode & 0o777, 0o700);
  await assert.rejects(createReleaseKeys({ keyId: "release-test", keyDir }), /exists|EEXIST/);
  assert.deepEqual(await readFile(result.privateKeyFile), before);
  for (const keyId of ["Uppercase", ".starts-with-dot", "a".repeat(65), "../escape"]) {
    await assert.rejects(createReleaseKeys({ keyId, keyDir }), /keyId/);
  }
});

test("prepare stages immutable resources and a signed feed without exposing secrets", async (t) => {
  const { options, dir } = await fixture(t);
  const plan = await prepareRelease(options);
  assert.equal(plan.version, "3.17.3");
  assert.deepEqual(
    plan.objects.map((item) => item.key),
    [
      "milocode/releases/3.17.3/win32-x64/MiloCode-3.17.3-win-x64.exe",
      "milocode/releases/3.17.3/win32-x64/MiloCode-3.17.3-win-x64.exe.blockmap",
      "milocode/stable/win32-x64/latest.json",
    ],
  );
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE KEY|privateKeyFile|ACCESS_KEY|test-signing/);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await validateReleasePlan(options.outputDir);
  await assert.rejects(prepareRelease(options), /exists|EEXIST/);
});

test(
  "Mac release stage uses the pinned official appcast signer",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const tools = join(import.meta.dirname, "../.cache/milocode-sparkle/2.10.1/bin");
    try {
      await access(join(tools, "generate_appcast"));
    } catch {
      t.skip("Stage the pinned Sparkle tools before running Mac release validation");
      return;
    }
    const { dir, options } = await fixture(t);
    const app = join(dir, "MiloCodeReleaseFixture.app/Contents");
    await mkdir(join(app, "MacOS"), { recursive: true });
    await copyFile("/usr/bin/true", join(app, "MacOS/fixture"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyFile = join(dir, "sparkle-test-key");
    const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString(
      "base64",
    );
    const publicKeyBase64 = Buffer.from(
      publicKey.export({ format: "jwk" }).x,
      "base64url",
    ).toString("base64");
    await writeFile(keyFile, seed, { mode: 0o600 });
    await writeFile(
      join(app, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.milo.release-fixture</string><key>CFBundleName</key><string>MiloCodeReleaseFixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>3.17.3</string><key>CFBundleShortVersionString</key><string>3.17.3</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>SUPublicEDKey</key><string>${publicKeyBase64}</string><key>SURequireSignedFeed</key><true/></dict></plist>`,
    );
    // Apple Silicon 本地 Mach-O 使用免费 ad-hoc 签名；不申请证书，也不改变系统信任。
    await runFile("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      join(dir, "MiloCodeReleaseFixture.app"),
    ]);
    const archive = join(dir, "input.zip");
    await runFile("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      join(dir, "MiloCodeReleaseFixture.app"),
      archive,
    ]);
    const cacheId = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    t.after(() =>
      rm(join(homedir(), "Library/Caches/Sparkle_generate_appcast", cacheId), {
        recursive: true,
        force: true,
      }),
    );
    const dmg = join(dir, "manual-install.dmg");
    await writeFile(dmg, "Non-executable engineering DMG fixture; never installed.");
    const mac = {
      archive,
      dmg,
      generateAppcast: join(tools, "generate_appcast"),
      edKeyFile: keyFile,
    };
    for (const [arch, input] of [
      ["arm64", "mac"],
      ["x64", "macX64"],
    ]) {
      const outputDir = join(dir, `release-${arch}`);
      const plan = await prepareRelease({
        ...options,
        outputDir,
        windows: undefined,
        [input]: mac,
        releaseNotes: "Validated local fixture; no installation or cloud upload.",
      });
      await validateReleasePlan(outputDir);
      const feed = plan.objects.find((item) => item.mutable);
      assert.equal(feed.localPath, `stable/darwin-${arch}/appcast.xml`);
      assert.ok(plan.objects.every((item) => item.platform === `darwin-${arch}`));
      assert.ok(
        plan.objects.some(
          (item) =>
            item.localPath === `releases/3.17.3/darwin-${arch}/MiloCode-3.17.3-mac-${arch}.dmg`,
        ),
      );
      const xml = await readFile(join(outputDir, feed.localPath), "utf8");
      assert.match(xml, /sparkle:edSignature="[A-Za-z0-9+/=]+"/);
      assert.ok(xml.includes(`/releases/3.17.3/darwin-${arch}/MiloCode-3.17.3-mac-${arch}.zip`));
      await runFile(join(tools, "sign_update"), [
        "--ed-key-file",
        keyFile,
        "--verify",
        join(outputDir, feed.localPath),
      ]);
    }

    // 使用真实 CLI 配置解析与官方 signer 同时准备两种架构，避免新增入口只在 API 测试里可用。
    const configFile = join(dir, "release.json");
    const outputDir = join(dir, "release-both");
    await writeFile(
      configFile,
      JSON.stringify({
        version: options.version,
        baseUrl: options.baseUrl,
        mac,
        macX64: mac,
      }),
    );
    await runReleaseCli(["prepare", "--config", configFile, "--out", outputDir]);
    const plan = await validateReleasePlan(outputDir);
    assert.deepEqual(
      plan.objects.filter((item) => item.mutable).map((item) => item.localPath),
      ["stable/darwin-arm64/appcast.xml", "stable/darwin-x64/appcast.xml"],
    );
    const x64Feed = plan.objects.find((item) => item.localPath === "stable/darwin-x64/appcast.xml");
    const changed = (await readFile(x64Feed.absolutePath, "utf8")).replaceAll(
      "/darwin-x64/",
      "/darwin-arm64/",
    );
    await writeFile(x64Feed.absolutePath, changed);
    const savedPlan = JSON.parse(await readFile(join(outputDir, "release-plan.json"), "utf8"));
    Object.assign(
      savedPlan.objects.find((item) => item.key === x64Feed.key),
      {
        size: Buffer.byteLength(changed),
        sha256: createHash("sha256").update(changed).digest("hex"),
        sha512: createHash("sha512").update(changed).digest("base64"),
      },
    );
    await writeFile(join(outputDir, "release-plan.json"), JSON.stringify(savedPlan));
    await assert.rejects(publishRelease({ dir: outputDir, dryRun: true }), /own platform ZIP/);
  },
);

test("unsafe release roots, prereleases and path-like versions are rejected", async (t) => {
  const { options } = await fixture(t);
  for (const version of ["../3.17.3", "3.17.3-beta.1", "3.17", "03.17.3"]) {
    await assert.rejects(prepareRelease({ ...options, version }), /version/);
  }
  for (const baseUrl of [
    "http://download.example.com/",
    "https://u:p@example.com/",
    "https://example.com/?token=x",
  ]) {
    await assert.rejects(prepareRelease({ ...options, baseUrl }), /HTTPS|URL/);
  }
});

test("changed staged payload is rejected before any network call", async (t) => {
  const { options } = await fixture(t);
  const plan = await prepareRelease(options);
  await writeFile(join(options.outputDir, plan.objects[0].localPath), "replaced payload");
  let requests = 0;
  await assert.rejects(
    publishRelease({
      dir: options.outputDir,
      client: {
        head: async () => {
          requests += 1;
        },
      },
    }),
    /changed|checksum|size/,
  );
  assert.equal(requests, 0);
});

test("dry run needs no credentials, network, or storage mutation", async (t) => {
  const { options } = await fixture(t);
  await prepareRelease(options);
  const result = await publishRelease({ dir: options.outputDir, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.objects.length, 3);
});

test("publishing uploads all resources before feeds and uses conditional writes", async (t) => {
  const { options } = await fixture(t);
  const plan = await prepareRelease(options);
  const stored = new Map();
  const writes = [];
  const client = {
    head: async (key) => stored.get(key) ?? null,
    put: async (object, condition) => {
      writes.push({ key: object.key, condition });
      stored.set(object.key, {
        size: object.size,
        sha512: object.sha512,
        version: plan.version,
        etag: '"stored"',
      });
    },
  };
  await publishRelease({ dir: options.outputDir, client });
  assert.deepEqual(
    writes.map((item) => item.key),
    plan.objects.map((item) => item.key),
  );
  assert.ok(writes.every((item) => item.condition.ifNoneMatch === "*"));
  writes.length = 0;
  await publishRelease({ dir: options.outputDir, client });
  assert.equal(writes.length, 0);
});

test("conflicting immutable resources and feed downgrades fail before feed writes", async (t) => {
  const { options } = await fixture(t);
  const plan = await prepareRelease(options);
  let puts = 0;
  const conflictClient = {
    head: async () => ({
      size: 123,
      sha512: "other",
      version: "3.17.3",
      etag: '"x"',
    }),
    put: async () => {
      puts += 1;
    },
  };
  await assert.rejects(
    publishRelease({ dir: options.outputDir, client: conflictClient }),
    /conflict/,
  );
  assert.equal(puts, 0);
  const newerClient = {
    head: async (key) =>
      key.includes("/stable/")
        ? { size: 42, sha512: "other", version: "3.17.4", etag: '"newer"' }
        : { ...plan.objects.find((item) => item.key === key), etag: '"asset"' },
    put: async () => {
      puts += 1;
    },
  };
  await assert.rejects(
    publishRelease({ dir: options.outputDir, client: newerClient }),
    /downgrade/,
  );
  assert.equal(puts, 0);
});

test("S3 signer binds payload, object path and conditional headers without leaking secret", () => {
  const result = signS3Request({
    method: "PUT",
    url: new URL("https://account.r2.cloudflarestorage.com/milocode-releases/milocode/a%20b.zip"),
    region: "auto",
    accessKeyId: "example-id",
    secretAccessKey: "example-secret",
    payloadSha256: "a".repeat(64),
    headers: { "if-none-match": "*", "content-type": "application/zip" },
    date: new Date("2026-11-13T00:00:00.000Z"),
  });
  assert.equal(result["x-amz-date"], "20261113T000000Z");
  assert.equal(result["x-amz-content-sha256"], "a".repeat(64));
  assert.match(result.authorization, /Credential=example-id\/20261113\/auto\/s3\/aws4_request/);
  assert.match(result.authorization, /if-none-match/);
  assert.doesNotMatch(JSON.stringify(result), /example-secret/);
  const changed = signS3Request({
    method: "PUT",
    url: new URL("https://account.r2.cloudflarestorage.com/milocode-releases/other.zip"),
    region: "auto",
    accessKeyId: "example-id",
    secretAccessKey: "example-secret",
    payloadSha256: "a".repeat(64),
    headers: {},
    date: new Date("2026-11-13T00:00:00.000Z"),
  });
  assert.notEqual(result.authorization, changed.authorization);
});

test("S3 client refuses redirects and encodes object keys without changing slash boundaries", async () => {
  const seen = [];
  const client = createS3Client({
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "milocode-releases",
    region: "auto",
    accessKeyId: "example-id",
    secretAccessKey: "example-secret",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return new Response(null, { status: 404 });
    },
  });
  assert.equal(await client.head("milocode/releases/a b.zip"), null);
  assert.equal(
    seen[0].url,
    "https://account.r2.cloudflarestorage.com/milocode-releases/milocode/releases/a%20b.zip",
  );
  assert.equal(seen[0].options.redirect, "error");
  assert.throws(() => createS3Client({ endpoint: "http://example.com" }), /HTTPS/);
});
