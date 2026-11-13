import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { lstat, open } from "node:fs/promises";

export const MILOCODE_RELEASE_SCHEMA_VERSION = 1;
export const MILOCODE_RELEASE_MAX_MANIFEST_BYTES = 256 * 1024;
export const MILOCODE_RELEASE_MAX_ARTIFACT_BYTES = 8 * 1024 ** 3;

const PRODUCT_ID = "app.milo.code";
const PLATFORM = "win32-x64";
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(message) {
  throw new Error(`MiloCode update verification failed: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail(`${label} has an invalid prototype`);
  }
  for (const key of Object.keys(value))
    if (DANGEROUS_KEYS.has(key)) fail(`${label} has an unsafe property`);
  return value;
}

function exactKeys(value, allowed, label) {
  record(value, label);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${label} contains unsupported fields`);
}

function decodeBase64(value, label, exactBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    fail(`${label} must be canonical base64`);
  }
  const result = Buffer.from(value, "base64");
  if (
    result.toString("base64") !== value ||
    (exactBytes !== undefined && result.length !== exactBytes)
  ) {
    fail(`${label} has an invalid length or encoding`);
  }
  return result;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    return fail(`${label} is not valid JSON`);
  }
}

function trustedUrl(value, label, allowInsecureLocalhost) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\\\s]/.test(value) ||
    /%(?:2e|2f|5c)/i.test(value)
  ) {
    fail(`${label} is not a canonical release URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail(`${label} is not an absolute URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(allowInsecureLocalhost === true && local && url.protocol === "http:")
  ) {
    fail(`${label} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash || url.href !== value) {
    fail(`${label} must not contain credentials, query, fragment or noncanonical paths`);
  }
  return url;
}

export function validateMiloCodeUpdatePolicy(policy) {
  record(policy, "update policy");
  if (policy.productId !== PRODUCT_ID || policy.platform !== PLATFORM)
    fail("unsupported product or platform policy");
  const base = trustedUrl(policy.releaseBaseUrl, "releaseBaseUrl", policy.allowInsecureLocalhost);
  if (!base.pathname.endsWith("/")) fail("releaseBaseUrl must end with a slash");
  const manifest = trustedUrl(policy.manifestUrl, "manifestUrl", policy.allowInsecureLocalhost);
  if (manifest.origin !== base.origin || !manifest.pathname.startsWith(base.pathname))
    fail("manifest URL is outside the trusted release root");
  record(policy.publicKeys, "publicKeys");
  const keys = Object.entries(policy.publicKeys);
  if (keys.length < 1 || keys.length > 8) fail("one to eight embedded public keys are required");
  for (const [keyId, pem] of keys) {
    if (!KEY_ID.test(keyId) || typeof pem !== "string" || pem.length > 4096)
      fail("invalid embedded public key");
    if (
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(
        pem.trim(),
      )
    )
      fail("embedded public key must contain only a SPKI PUBLIC KEY PEM");
    let key;
    try {
      key = createPublicKey(pem);
    } catch {
      fail("invalid embedded public key");
    }
    if (key.asymmetricKeyType !== "ed25519") fail("embedded public key must be Ed25519");
  }
  return policy;
}

function validatePayload(payload, policy) {
  exactKeys(
    payload,
    [
      "schemaVersion",
      "productId",
      "platform",
      "channel",
      "version",
      "releaseDate",
      "releaseNotes",
      "files",
    ],
    "release payload",
  );
  if (
    payload.schemaVersion !== MILOCODE_RELEASE_SCHEMA_VERSION ||
    payload.productId !== PRODUCT_ID ||
    payload.platform !== PLATFORM ||
    payload.channel !== "stable"
  ) {
    fail("release product, platform, channel or schema does not match this client");
  }
  if (policy.productId !== payload.productId || policy.platform !== payload.platform)
    fail("release does not match the embedded policy");
  if (
    typeof payload.version !== "string" ||
    payload.version.length > 64 ||
    !STABLE_VERSION.test(payload.version)
  )
    fail("release version must be a stable major.minor.patch version");
  if (!payload.version.split(".").every((part) => Number.isSafeInteger(Number(part))))
    fail("release version components exceed safe integers");
  if (
    typeof payload.releaseDate !== "string" ||
    !Number.isFinite(Date.parse(payload.releaseDate)) ||
    new Date(payload.releaseDate).toISOString() !== payload.releaseDate
  ) {
    fail("releaseDate must be a canonical ISO timestamp");
  }
  if (
    payload.releaseNotes !== undefined &&
    (typeof payload.releaseNotes !== "string" ||
      Buffer.byteLength(payload.releaseNotes, "utf8") > 64 * 1024)
  )
    fail("release notes must be bounded markdown text");
  if (!Array.isArray(payload.files) || payload.files.length !== 1)
    fail("exactly one complete NSIS installer is required");
  const base = trustedUrl(policy.releaseBaseUrl, "releaseBaseUrl", policy.allowInsecureLocalhost);
  for (const file of payload.files) {
    exactKeys(file, ["url", "sha512", "size"], "release file");
    const url = trustedUrl(file.url, "installer URL", policy.allowInsecureLocalhost);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      !url.pathname.toLowerCase().endsWith(".exe")
    )
      fail("installer is outside the trusted release root or is not NSIS EXE");
    if (
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > MILOCODE_RELEASE_MAX_ARTIFACT_BYTES
    )
      fail("installer size is invalid");
    decodeBase64(file.sha512, "installer SHA512", 64);
  }
  return payload;
}

function freezePayload(payload) {
  for (const file of payload.files) Object.freeze(file);
  Object.freeze(payload.files);
  return Object.freeze(payload);
}

/** 发布工具只签原始 JSON 字节；客户端先验签后解析，不依赖 JSON 重序列化。 */
export function signMiloCodeRelease(payload, { keyId, privateKey }) {
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) fail("invalid signing keyId");
  const file = payload?.files?.[0];
  let base;
  try {
    base = new URL(".", file.url).href;
  } catch {
    fail("release requires an absolute installer URL");
  }
  validatePayload(payload, {
    productId: PRODUCT_ID,
    platform: PLATFORM,
    releaseBaseUrl: base,
  });
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  if (data.length > MILOCODE_RELEASE_MAX_MANIFEST_BYTES / 2) fail("release payload is too large");
  const key =
    typeof privateKey === "string" || Buffer.isBuffer(privateKey)
      ? createPrivateKey(privateKey)
      : privateKey;
  if (key?.asymmetricKeyType !== "ed25519" || key.type !== "private")
    fail("signing key must be an Ed25519 private key");
  return (
    JSON.stringify({
      schemaVersion: MILOCODE_RELEASE_SCHEMA_VERSION,
      keyId,
      payload: data.toString("base64"),
      signature: sign(null, data, key).toString("base64"),
    }) + "\n"
  );
}

export function verifyMiloCodeRelease(rawEnvelope, policy) {
  validateMiloCodeUpdatePolicy(policy);
  if (
    typeof rawEnvelope !== "string" ||
    Buffer.byteLength(rawEnvelope, "utf8") > MILOCODE_RELEASE_MAX_MANIFEST_BYTES
  )
    fail("release envelope is missing or too large");
  const envelope = parseJson(rawEnvelope, "release envelope");
  exactKeys(envelope, ["schemaVersion", "keyId", "payload", "signature"], "release envelope");
  if (
    envelope.schemaVersion !== MILOCODE_RELEASE_SCHEMA_VERSION ||
    typeof envelope.keyId !== "string" ||
    !KEY_ID.test(envelope.keyId) ||
    !Object.hasOwn(policy.publicKeys, envelope.keyId)
  )
    fail("unknown release signing key or schema");
  const data = decodeBase64(envelope.payload, "release payload");
  const signature = decodeBase64(envelope.signature, "release signature", 64);
  if (!verify(null, data, createPublicKey(policy.publicKeys[envelope.keyId]), signature))
    fail("release signature is invalid");
  // Buffer 的默认 UTF-8 解码会用替换字符接受坏字节；必须拒绝不同字节同一文本的歧义。
  let json;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    fail("release payload is not UTF-8");
  }
  return freezePayload(validatePayload(parseJson(json, "release payload"), policy));
}

/** 缓存命中及真正安装前都重验签名和整包，不能依赖会被 NSIS 跳过的 publisherName hook。 */
export async function verifyMiloCodeUpdateArtifact(filePath, rawEnvelope, policy, options = {}) {
  const payload = verifyMiloCodeRelease(rawEnvelope, policy);
  if (options.expectedVersion !== undefined && payload.version !== options.expectedVersion)
    fail("cached installer version no longer matches the frozen update target");
  const expected = payload.files[0];
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) fail("installer must be a regular file");
  const handle = await open(filePath, "r");
  try {
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.size !== expected.size ||
      initial.ino !== before.ino ||
      initial.dev !== before.dev
    )
      fail("installer file identity or size does not match");
    const hash = createHash("sha512");
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytesRead += chunk.length;
      if (bytesRead > expected.size) fail("installer changed during verification");
      hash.update(chunk);
    }
    const after = await handle.stat();
    const finalPath = await lstat(filePath);
    if (
      bytesRead !== expected.size ||
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalPath.ino !== initial.ino ||
      finalPath.dev !== initial.dev ||
      finalPath.size !== initial.size ||
      finalPath.mtimeMs !== initial.mtimeMs ||
      finalPath.ctimeMs !== initial.ctimeMs ||
      !timingSafeEqual(hash.digest(), Buffer.from(expected.sha512, "base64"))
    )
      fail("installer hash or file identity does not match the signed release");
    return payload;
  } finally {
    await handle.close();
  }
}
