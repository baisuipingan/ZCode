import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAdminReleaseClient,
  releaseStorageClientFromEnv,
} from "./milocode-release-admin.mjs";
import { verifyPublicReleaseObject } from "./milocode-release-network.mjs";
import { prepareRelease, publishRelease } from "./milocode-release-stage.mjs";

const TOKEN = "TEST_ADMIN_SESSION_MUST_NOT_LEAK";
const ADMIN_KEY = "TEST_EXISTING_ADMIN_KEY_MUST_NOT_LEAK";
const BASE = "https://download.editor.vip/milocode/";
const API = "https://gateway.example.test/api/v1";
const BUCKET = "milocode-releases";
const OBJECT = {
  key: "milocode/releases/3.17.3/win32-x64/MiloCode-3.17.3-win-x64.exe",
  size: 7,
  contentType: "application/octet-stream",
  mutable: false,
  version: "3.17.3",
  sha256: createHash("sha256").update("payload").digest("hex"),
  sha512: createHash("sha512").update("payload").digest("base64"),
};

const ok = (data) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "content-type": "application/json" },
  });
function authorization(object, condition = { if_none_match: "*" }) {
  const headers = {
    "Content-Length": String(object.size),
    "Content-Type": object.content_type ?? object.contentType,
    "Cache-Control": object.key.includes("/stable/")
      ? "no-cache, max-age=0, must-revalidate"
      : "public, max-age=31536000, immutable",
    "X-Amz-Meta-Sha256": object.sha256,
    "X-Amz-Meta-Sha512": object.sha512,
    "X-Amz-Meta-Milocode-Version": object.version,
    ...(condition.if_match
      ? { "If-Match": condition.if_match }
      : { "If-None-Match": "*" }),
  };
  const url = new URL(
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/${BUCKET}/${object.key}`,
  );
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Signature", "b".repeat(64));
  url.searchParams.set(
    "X-Amz-Credential",
    "TEST_STORAGE_ACCESS_KEY/20261113/auto/s3/aws4_request",
  );
  url.searchParams.set("X-Amz-Expires", "900");
  url.searchParams.set(
    "X-Amz-SignedHeaders",
    ["host", ...Object.keys(headers).map((name) => name.toLowerCase())]
      .sort()
      .join(";"),
  );
  return {
    url: url.href,
    headers,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "milocode-admin-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installer = join(dir, "input.exe");
  await writeFile(installer, "payload");
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = join(dir, "private.pem");
  await writeFile(
    privateKeyFile,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    {
      mode: 0o600,
    },
  );
  const outputDir = join(dir, "release");
  await prepareRelease({
    version: "3.17.3",
    baseUrl: BASE,
    outputDir,
    windows: { installer, privateKeyFile, keyId: "test-admin" },
  });
  return { dir, installer, outputDir };
}

function mockStorage({
  configuration = {},
  authorizationMutation,
  denied,
  deniedAt,
  corruptPublic,
  adminKey,
} = {}) {
  const calls = [];
  const saved = new Map();
  const bodies = new Map();
  let pending;
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const body =
      typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });
    assert.equal(options.redirect, "error");
    if (url.origin === new URL(API).origin) {
      if (adminKey) {
        assert.equal(options.headers["x-api-key"], adminKey);
        assert.equal(options.headers.authorization, undefined);
      } else {
        assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(options.headers["x-api-key"], undefined);
      }
      if (denied && (!deniedAt || url.pathname.endsWith(deniedAt)))
        return new Response("DO_NOT_ECHO_PRIVATE_DIAGNOSTICS", {
          status: denied,
        });
      if (options.method === "GET") {
        assert.equal(url.pathname, "/api/v1/admin/desktop/release-storage");
        return ok({
          configured: true,
          bucket: BUCKET,
          release_base_url: BASE,
          ...configuration,
        });
      }
      if (url.pathname.endsWith("/objects/head"))
        return ok(
          saved.has(body.key)
            ? { exists: true, ...saved.get(body.key) }
            : { exists: false },
        );
      assert(url.pathname.endsWith("/uploads"));
      pending = body;
      const raw = authorization(body, body);
      authorizationMutation?.(raw);
      return ok(raw);
    }
    assert(!JSON.stringify(options.headers).includes(TOKEN));
    assert(!JSON.stringify(options.headers).includes(ADMIN_KEY));
    assert(!options.headers.authorization);
    assert(!options.headers["x-api-key"]);
    assert(!options.headers.cookie);
    if (options.method === "PUT") {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, pending.size);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        pending.sha256,
      );
      saved.set(pending.key, {
        size: pending.size,
        sha512: pending.sha512,
        version: pending.version,
        etag: '"test-etag"',
      });
      bodies.set(pending.key, bytes);
      return new Response(null, { status: 200 });
    }
    const object = saved.get(url.pathname.slice(1));
    assert(object);
    return options.method === "HEAD"
      ? new Response(null, {
          headers: { "content-length": String(object.size) },
        })
      : options.headers.range
        ? new Response("p", {
            status: 206,
            headers: { "content-range": `bytes 0-0/${object.size}` },
          })
        : new Response(
            corruptPublic
              ? Buffer.alloc(object.size, "X")
              : bodies.get(url.pathname.slice(1)),
          );
  };
  return {
    calls,
    saved,
    client: createAdminReleaseClient({
      apiUrl: API,
      ...(adminKey ? { adminKey } : { token: TOKEN }),
      fetchImpl,
    }),
  };
}

test("admin adapter consumes saved backend config and streams resources before the feed without leaking JWT", async (t) => {
  const { outputDir } = await fixture(t);
  const mock = mockStorage();
  const result = await publishRelease({ dir: outputDir, client: mock.client });
  assert.equal(result.dryRun, false);
  const uploads = mock.calls.filter((call) =>
    call.url.pathname.endsWith("/uploads"),
  );
  assert.deepEqual(
    uploads.map((call) => call.body.key),
    [OBJECT.key, "milocode/stable/win32-x64/latest.json"],
  );
  assert.equal(uploads[0].body.if_none_match, "*");
  assert.equal(uploads[0].body.content_type, "application/octet-stream");
  assert.equal(uploads[1].body.content_type, "application/json");
  assert(!JSON.stringify(result).includes(TOKEN));
  assert(!JSON.stringify(result).includes("X-Amz-Signature"));
  const before = uploads.length;
  await publishRelease({ dir: outputDir, client: mock.client });
  assert.equal(
    mock.calls.filter((call) => call.url.pathname.endsWith("/uploads")).length,
    before,
  );
});

test("step-up rejection while requesting a PUT URL never falls back from administrator Key to another credential", async (t) => {
  const { outputDir } = await fixture(t);
  const mock = mockStorage({
    adminKey: ADMIN_KEY,
    denied: 403,
    deniedAt: "/uploads",
  });
  await assert.rejects(
    publishRelease({ dir: outputDir, client: mock.client }),
    /step-up.*cannot be bypassed/i,
  );
  assert.equal(
    mock.calls.filter((call) => call.url.pathname.endsWith("/uploads")).length,
    1,
  );
  assert(mock.calls.every((call) => call.url.origin === new URL(API).origin));
  assert(
    mock.calls.every((call) => call.options.headers["x-api-key"] === ADMIN_KEY),
  );
  assert(mock.calls.every((call) => !call.options.headers.authorization));
  assert(!mock.calls.some((call) => call.options.method === "PUT"));
});

test("existing administrator Key uses only the configured admin origin and never reaches storage, public reads or the release plan", async (t) => {
  const { outputDir } = await fixture(t);
  const mock = mockStorage({ adminKey: ADMIN_KEY });
  const result = await publishRelease({ dir: outputDir, client: mock.client });
  assert.equal(result.dryRun, false);
  const adminCalls = mock.calls.filter(
    (call) => call.url.origin === new URL(API).origin,
  );
  assert(adminCalls.length > 0);
  assert(
    adminCalls.every((call) => call.options.headers["x-api-key"] === ADMIN_KEY),
  );
  const directCalls = mock.calls.filter(
    (call) => call.url.origin !== new URL(API).origin,
  );
  assert(directCalls.some((call) => call.options.method === "PUT"));
  assert(directCalls.some((call) => call.options.method === "HEAD"));
  assert(directCalls.some((call) => !call.options.method));
  assert(directCalls.every((call) => !call.options.headers["x-api-key"]));
  assert(!JSON.stringify(result).includes(ADMIN_KEY));
  assert(
    !(await readFile(join(outputDir, "release-plan.json"), "utf8")).includes(
      ADMIN_KEY,
    ),
  );
});

test("same-size incorrect public bytes block stable publication even when HEAD metadata matches", async (t) => {
  const { outputDir } = await fixture(t);
  const mock = mockStorage({ corruptPublic: true });
  await assert.rejects(
    publishRelease({ dir: outputDir, client: mock.client }),
    /SHA512/,
  );
  assert.deepEqual(
    mock.calls
      .filter((call) => call.url.pathname.endsWith("/uploads"))
      .map((call) => call.body.key),
    [OBJECT.key],
  );
});

test("public verification reads each object as a stream, including stable feed bytes", async () => {
  const data = Buffer.from("verified stable metadata");
  const object = {
    size: data.length,
    sha512: createHash("sha512").update(data).digest("base64"),
    publicUrl: `${BASE}stable/win32-x64/latest.json`,
  };
  const methods = [];
  await verifyPublicReleaseObject(object, async (_url, options) => {
    methods.push(options.method ?? "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["accept-encoding"], "identity");
    assert.equal(options.headers.authorization, undefined);
    if (options.method === "HEAD")
      return new Response(null, {
        headers: { "content-length": String(data.length) },
      });
    if (options.headers.range)
      return new Response(data.subarray(0, 1), {
        status: 206,
        headers: { "content-range": `bytes 0-0/${data.length}` },
      });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(data.subarray(0, 5));
          controller.enqueue(data.subarray(5));
          controller.close();
        },
      }),
    );
  });
  assert.deepEqual(methods, ["HEAD", "GET", "GET"]);
});

test("mismatched or disabled backend release storage fails before any HEAD or upload", async (t) => {
  const { outputDir } = await fixture(t);
  for (const configuration of [
    { release_base_url: "https://other.example/milocode/" },
    { configured: false },
  ]) {
    const mock = mockStorage({ configuration });
    await assert.rejects(
      publishRelease({ dir: outputDir, client: mock.client }),
      /base URL|Configure desktop release/,
    );
    assert.equal(mock.calls.length, 1);
  }
});

test("admin 401 and step-up 403 stop publication and never echo response diagnostics", async () => {
  for (const [denied, adminKey] of [
    [401, undefined],
    [403, undefined],
    [401, ADMIN_KEY],
    [403, ADMIN_KEY],
  ]) {
    const mock = mockStorage({ denied, adminKey });
    await assert.rejects(
      mock.client.validateConfiguration({ baseUrl: BASE }),
      (error) => {
        assert(!String(error).includes(TOKEN));
        assert(!String(error).includes(ADMIN_KEY));
        assert(!String(error).includes("PRIVATE_DIAGNOSTICS"));
        assert.match(
          String(error),
          denied === 403
            ? /step-up.*cannot be bypassed/i
            : /session expired|credential.*invalid/i,
        );
        return true;
      },
    );
    assert.equal(mock.calls.length, 1);
  }
});

test("R2 virtual hosts accept only the configured bucket and its exact object path", async (t) => {
  const { installer } = await fixture(t);
  for (const jurisdiction of ["", ".eu", ".fedramp"]) {
    const mock = mockStorage({
      authorizationMutation(raw) {
        const url = new URL(raw.url);
        url.hostname = `${BUCKET}.${"a".repeat(32)}${jurisdiction}.r2.cloudflarestorage.com`;
        url.pathname = `/${OBJECT.key}`;
        raw.url = url.href;
      },
    });
    await mock.client.validateConfiguration({ baseUrl: BASE });
    await mock.client.put(
      { ...OBJECT, absolutePath: installer },
      { ifNoneMatch: "*" },
    );
    const upload = mock.calls.find((call) => call.options.method === "PUT");
    assert.equal(
      upload.url.hostname,
      `${BUCKET}.${"a".repeat(32)}${jurisdiction}.r2.cloudflarestorage.com`,
    );
    assert.equal(upload.url.pathname, `/${OBJECT.key}`);
  }
});

test("unsafe signed targets, headers, conditions and lifetimes are rejected before storage PUT", async (t) => {
  const { installer } = await fixture(t);
  const mutations = [
    (raw) => {
      const url = new URL(raw.url);
      url.hostname = `other-bucket.${url.hostname}`;
      url.pathname = `/${OBJECT.key}`;
      raw.url = url.href;
    },
    (raw) => {
      const url = new URL(raw.url);
      url.hostname = `${BUCKET}.${url.hostname}.attacker.example`;
      url.pathname = `/${OBJECT.key}`;
      raw.url = url.href;
    },
    (raw) => {
      const url = new URL(raw.url);
      url.hostname = `${BUCKET}.${url.hostname}`;
      raw.url = url.href;
    },
    (raw) => {
      const url = new URL(raw.url);
      url.hostname = `${BUCKET}-other.${url.hostname}`;
      url.pathname = `/${OBJECT.key}`;
      raw.url = url.href;
    },
    (raw) => {
      raw.url = raw.url.replace("https:", "http:");
    },
    (raw) => {
      raw.url = raw.url.replace(
        `${"a".repeat(32)}.r2.cloudflarestorage.com`,
        "attacker.example",
      );
    },
    (raw) => {
      raw.url = raw.url.replace(BUCKET, "other-bucket");
    },
    (raw) => {
      raw.headers.Authorization = `Bearer ${TOKEN}`;
    },
    (raw) => {
      raw.headers["x-api-key"] = ADMIN_KEY;
    },
    (raw) => {
      raw.headers.Host = "attacker.example";
    },
    (raw) => {
      raw.headers.Cookie = "session=private";
    },
    (raw) => {
      raw.headers["Content-Length"] = "1";
    },
    (raw) => {
      raw.headers["If-Match"] = '"stale"';
    },
    (raw) => {
      raw.headers["X-Amz-Meta-Sha256"] = "bad";
    },
    (raw) => {
      raw.headers["Content-Type"] =
        "application/octet-stream\r\nHost: attacker.example";
    },
    (raw) => {
      raw.expires_at = new Date(Date.now() - 1000).toISOString();
    },
    (raw) => {
      const url = new URL(raw.url);
      url.searchParams.set("X-Amz-SignedHeaders", "host");
      raw.url = url.href;
    },
  ];
  for (const authorizationMutation of mutations) {
    const mock = mockStorage({ authorizationMutation });
    await mock.client.validateConfiguration({ baseUrl: BASE });
    await assert.rejects(
      mock.client.put(
        { ...OBJECT, absolutePath: installer },
        { ifNoneMatch: "*" },
      ),
      /upload|signature|checksum/i,
    );
    assert.equal(
      mock.calls.filter((call) => call.options.method === "PUT").length,
      0,
    );
  }
});

test("admin metadata and signed URL network errors stay sanitized", async (t) => {
  const { installer } = await fixture(t);
  let configurationRead = false;
  const client = createAdminReleaseClient({
    apiUrl: API,
    token: TOKEN,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (!configurationRead) {
        configurationRead = true;
        return ok({ configured: true, bucket: BUCKET, release_base_url: BASE });
      }
      if (options.method === "POST") return ok(authorization(OBJECT));
      throw new Error(`private error includes ${url.href} ${TOKEN}`);
    },
  });
  await client.validateConfiguration({ baseUrl: BASE });
  await assert.rejects(
    client.put({ ...OBJECT, absolutePath: installer }, { ifNoneMatch: "*" }),
    (error) => {
      assert.match(String(error), /Direct release upload failed/);
      assert(!String(error).includes(TOKEN));
      assert(!String(error).includes("X-Amz-Signature"));
      return true;
    },
  );
});

test("a local file changed after preflight cannot advance the feed", async (t) => {
  const { installer } = await fixture(t);
  await writeFile(installer, "CHANGED");
  const calls = [];
  const client = createAdminReleaseClient({
    apiUrl: API,
    token: TOKEN,
    fetchImpl: async (input, options) => {
      calls.push(options.method);
      if (options.method === "GET")
        return ok({ configured: true, bucket: BUCKET, release_base_url: BASE });
      if (options.method === "POST") return ok(authorization(OBJECT));
      for await (const _chunk of options.body) {
        /* storage accepts bytes before the publisher can compare */
      }
      return new Response(null, { status: 200 });
    },
  });
  await client.validateConfiguration({ baseUrl: BASE });
  await assert.rejects(
    client.put({ ...OBJECT, absolutePath: installer }, { ifNoneMatch: "*" }),
    /changed during upload/,
  );
  assert.deepEqual(calls, ["GET", "POST", "PUT"]);
});

test("transport selection rejects mixed credentials while dry-run reads none", async (t) => {
  assert.throws(
    () =>
      releaseStorageClientFromEnv({
        MILOCODE_RELEASE_ADMIN_API_URL: API,
        MILOCODE_RELEASE_ADMIN_TOKEN: TOKEN,
        MILOCODE_RELEASE_S3_ENDPOINT: "https://s3.example",
      }),
    /mixed configuration/,
  );
  assert.throws(
    () => releaseStorageClientFromEnv({ MILOCODE_RELEASE_ADMIN_API_URL: API }),
    /ADMIN_TOKEN/,
  );
  assert.throws(
    () =>
      releaseStorageClientFromEnv({
        MILOCODE_RELEASE_ADMIN_API_URL: API,
        MILOCODE_RELEASE_ADMIN_TOKEN: TOKEN,
        MILOCODE_RELEASE_ADMIN_KEY: ADMIN_KEY,
      }),
    /exactly one|either.*token.*key/i,
  );
  assert.throws(
    () =>
      createAdminReleaseClient({
        apiUrl: API,
        token: TOKEN,
        adminKey: ADMIN_KEY,
      }),
    /exactly one|either.*token.*key/i,
  );
  assert.throws(
    () =>
      releaseStorageClientFromEnv({
        MILOCODE_RELEASE_ADMIN_API_URL: API,
        MILOCODE_RELEASE_ADMIN_KEY: ADMIN_KEY,
        MILOCODE_RELEASE_S3_ACCESS_KEY_ID: "TEST_STORAGE_KEY",
      }),
    /mixed configuration/,
  );
  assert.throws(
    () =>
      releaseStorageClientFromEnv({ MILOCODE_RELEASE_ADMIN_KEY: ADMIN_KEY }),
    /ADMIN_API_URL/,
  );
  assert.doesNotThrow(() =>
    releaseStorageClientFromEnv({
      MILOCODE_RELEASE_ADMIN_API_URL: API,
      MILOCODE_RELEASE_ADMIN_KEY: ADMIN_KEY,
    }),
  );
  assert.throws(
    () => createAdminReleaseClient({ apiUrl: API, adminKey: "unsafe\nheader" }),
    /valid.*credential|valid.*key/i,
  );
  assert.throws(
    () =>
      createAdminReleaseClient({
        apiUrl: "http://example/api/v1",
        token: TOKEN,
      }),
    /HTTPS/,
  );
  const { outputDir } = await fixture(t);
  const env = new Proxy(
    {},
    {
      get() {
        throw new Error("Dry run must not read environment credentials");
      },
    },
  );
  const result = await publishRelease({ dir: outputDir, dryRun: true, env });
  assert.equal(result.dryRun, true);
  assert(!JSON.stringify(result).includes(TOKEN));
  const plan = JSON.parse(
    await readFile(join(outputDir, "release-plan.json"), "utf8"),
  );
  assert.equal(plan.baseUrl, BASE);
});
