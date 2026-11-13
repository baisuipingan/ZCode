import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  signMiloCodeRelease,
  validateMiloCodeUpdatePolicy,
  verifyMiloCodeRelease,
  verifyMiloCodeUpdateArtifact,
} from "./milocode-release-trust.mjs";

const key = generateKeyPairSync("ed25519");
const publicKey = key.publicKey.export({ format: "pem", type: "spki" });
const bytes = Buffer.from("MiloCode test installer fixture, never executable");
const policy = {
  manifestUrl: "https://downloads.example.com/milocode/stable/win32-x64/latest.json",
  releaseBaseUrl: "https://downloads.example.com/milocode/",
  publicKeys: { "engineering-test": publicKey },
  productId: "app.milo.code",
  platform: "win32-x64",
};

function payload() {
  return {
    schemaVersion: 1,
    productId: "app.milo.code",
    platform: "win32-x64",
    channel: "stable",
    version: "3.17.3",
    releaseDate: "2026-11-13T00:00:00.000Z",
    releaseNotes: "工程验证归档，不发布、不运行安装程序。",
    files: [
      {
        url: "https://downloads.example.com/milocode/3.17.3/win32-x64/MiloCode-3.17.3.exe",
        size: bytes.length,
        sha512: createHash("sha512").update(bytes).digest("base64"),
      },
    ],
  };
}

function envelope(value) {
  return signMiloCodeRelease(value, {
    keyId: "engineering-test",
    privateKey: key.privateKey,
  });
}

function uncheckedEnvelope(value) {
  const raw = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return JSON.stringify({
    schemaVersion: 1,
    keyId: "engineering-test",
    payload: raw.toString("base64"),
    signature: sign(null, raw, key.privateKey).toString("base64"),
  });
}

test("release signing round trip preserves verified raw values and freezes artifact metadata", () => {
  const input = payload();
  const actual = verifyMiloCodeRelease(envelope(input), policy);
  assert.deepEqual(actual, input);
  assert.ok(Object.isFrozen(actual));
  assert.ok(Object.isFrozen(actual.files));
  assert.ok(Object.isFrozen(actual.files[0]));
});

test("unsigned, tampered, wrong key and unknown key releases are rejected", () => {
  const raw = JSON.parse(envelope(payload()));
  assert.throws(() => verifyMiloCodeRelease(JSON.stringify(payload()), policy));
  assert.throws(
    () =>
      verifyMiloCodeRelease(
        JSON.stringify({
          ...raw,
          payload: Buffer.from("{}").toString("base64"),
        }),
        policy,
      ),
    /signature/,
  );
  assert.throws(
    () => verifyMiloCodeRelease(JSON.stringify({ ...raw, keyId: "unknown" }), policy),
    /key/,
  );
  const other = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      verifyMiloCodeRelease(envelope(payload()), {
        ...policy,
        publicKeys: {
          "engineering-test": other.publicKey.export({
            type: "spki",
            format: "pem",
          }),
        },
      }),
    /signature/,
  );
});

test("signed but unsupported identities, versions, web installer fields and malformed metadata are rejected", () => {
  for (const change of [
    { productId: "other.product" },
    { platform: "darwin-arm64" },
    { channel: "preview" },
    { schemaVersion: 2 },
    { version: "3.17.3+fix1" },
    { version: "3.17.3-beta.1" },
    { version: "03.17.3" },
    { version: "9007199254740992.1.0" },
    { releaseDate: "2026-11-13" },
    { packages: {} },
    { files: [] },
    { files: [payload().files[0], payload().files[0]] },
    { files: [{ ...payload().files[0], size: 0 }] },
    { files: [{ ...payload().files[0], sha512: "not a SHA512" }] },
  ])
    assert.throws(() =>
      verifyMiloCodeRelease(uncheckedEnvelope({ ...payload(), ...change }), policy),
    );
});

test("trusted HTTPS origin and path cannot be escaped by signed release metadata", () => {
  for (const url of [
    "http://downloads.example.com/milocode/package.exe",
    "https://evil.example.com/milocode/package.exe",
    "https://downloads.example.com/milocode-evil/package.exe",
    "https://downloads.example.com/milocode/../package.exe",
    "https://downloads.example.com/milocode/%2e%2e/package.exe",
    "https://downloads.example.com/milocode/a%2fpackage.exe",
    "https://user@downloads.example.com/milocode/package.exe",
    "https://downloads.example.com/milocode/package.exe?token=secret",
    "https://downloads.example.com/milocode/package.exe#ignored",
    "https://downloads.example.com/milocode/package.zip",
  ]) {
    const value = payload();
    value.files[0].url = url;
    assert.throws(() => verifyMiloCodeRelease(uncheckedEnvelope(value), policy), url);
  }
});

test("policy is constrained to HTTPS and approved loopback testing only", () => {
  assert.throws(
    () =>
      validateMiloCodeUpdatePolicy({
        ...policy,
        releaseBaseUrl: "https://downloads.example.com/milocode",
      }),
    /slash/,
  );
  assert.throws(
    () =>
      validateMiloCodeUpdatePolicy({
        ...policy,
        manifestUrl: "https://other.example.com/latest.json",
      }),
    /outside/,
  );
  const local = {
    ...policy,
    manifestUrl: "http://127.0.0.1:8081/milocode/latest.json",
    releaseBaseUrl: "http://127.0.0.1:8081/milocode/",
  };
  assert.throws(() => validateMiloCodeUpdatePolicy(local), /HTTPS/);
  assert.doesNotThrow(() =>
    validateMiloCodeUpdatePolicy({ ...local, allowInsecureLocalhost: true }),
  );
  assert.throws(
    () =>
      validateMiloCodeUpdatePolicy({
        ...local,
        manifestUrl: "http://other.example.com/milocode/latest.json",
        releaseBaseUrl: "http://other.example.com/milocode/",
        allowInsecureLocalhost: true,
      }),
    /HTTPS/,
  );
});

test("embedded policy accepts only SPKI public PEM and never private material", () => {
  const privatePem = key.privateKey.export({ type: "pkcs8", format: "pem" });
  for (const pem of [privatePem, publicKey + privatePem, privatePem + publicKey]) {
    assert.throws(
      () =>
        validateMiloCodeUpdatePolicy({
          ...policy,
          publicKeys: { "engineering-test": pem },
        }),
      /SPKI PUBLIC KEY/,
    );
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      validateMiloCodeUpdatePolicy({
        ...policy,
        publicKeys: {
          "engineering-test": rsa.publicKey.export({
            type: "spki",
            format: "pem",
          }),
        },
      }),
    /Ed25519/,
  );
});

test("dangerous payload keys, noncanonical base64 and excessive manifests are rejected", () => {
  const raw = JSON.parse(envelope(payload()));
  assert.throws(
    () => verifyMiloCodeRelease(JSON.stringify({ ...raw, payload: `${raw.payload}\n` }), policy),
    /base64/,
  );
  assert.throws(() => verifyMiloCodeRelease(" ".repeat(256 * 1024 + 1), policy), /large/);
  assert.throws(
    () => verifyMiloCodeRelease(uncheckedEnvelope('{"__proto__":{},"schemaVersion":1}'), policy),
    /unsafe/,
  );
});

test("installer verification binds cache files to the signed version, bytes, size and regular-file identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "milocode-release-trust-"));
  try {
    const path = join(root, "fixture.exe");
    const raw = envelope(payload());
    await writeFile(path, bytes);
    assert.equal(
      (
        await verifyMiloCodeUpdateArtifact(path, raw, policy, {
          expectedVersion: "3.17.3",
        })
      ).version,
      "3.17.3",
    );
    await assert.rejects(
      verifyMiloCodeUpdateArtifact(path, raw, policy, {
        expectedVersion: "3.17.4",
      }),
      /version/,
    );
    await writeFile(path, Buffer.alloc(bytes.length, 0));
    await assert.rejects(verifyMiloCodeUpdateArtifact(path, raw, policy), /hash/);
    await writeFile(path, bytes.subarray(1));
    await assert.rejects(verifyMiloCodeUpdateArtifact(path, raw, policy), /size/);
    await writeFile(path, bytes);
    await symlink(path, join(root, "symlink.exe"));
    await assert.rejects(
      verifyMiloCodeUpdateArtifact(join(root, "symlink.exe"), raw, policy),
      /regular/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
