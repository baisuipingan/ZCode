import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { verifyPublicReleaseObject } from "./milocode-release-network.mjs";
import { releaseS3ClientFromEnv } from "./milocode-release-s3.mjs";

const ADMIN_FIELDS = [
  "MILOCODE_RELEASE_ADMIN_API_URL",
  "MILOCODE_RELEASE_ADMIN_TOKEN",
  "MILOCODE_RELEASE_ADMIN_KEY",
];
const S3_FIELDS = [
  "MILOCODE_RELEASE_S3_ENDPOINT",
  "MILOCODE_RELEASE_BUCKET",
  "MILOCODE_RELEASE_S3_REGION",
  "MILOCODE_RELEASE_S3_ACCESS_KEY_ID",
  "MILOCODE_RELEASE_S3_SECRET_ACCESS_KEY",
];
const SAFE_HEADERS = new Set([
  "content-length",
  "content-type",
  "cache-control",
  "if-match",
  "if-none-match",
  "x-amz-content-sha256",
  "x-amz-checksum-sha256",
  "x-amz-meta-sha256",
  "x-amz-meta-sha512",
  "x-amz-meta-milocode-version",
]);

function apiRoot(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Release admin API URL must use HTTPS");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/.*api\/v1\/?$/.test(url.pathname)
  )
    throw new Error(
      "Release admin API URL must be an HTTPS API base ending in /api/v1",
    );
  return new URL(
    `${url.pathname.replace(/\/$/, "")}/admin/desktop/release-storage`,
    url.origin,
  );
}

function uploadTarget(raw, object, configuration) {
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    throw new Error("Release upload authorization is invalid");
  }
  const host = url.hostname;
  const r2AccountHost =
    /^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/;
  const r2 = r2AccountHost.test(host);
  // 复用备份连接时 ForcePathStyle=false 会由 SDK 生成虚拟桶 host；仍只信配置桶的精确前缀。
  const r2Virtual =
    host.startsWith(`${configuration.bucket}.`) &&
    r2AccountHost.test(host.slice(configuration.bucket.length + 1));
  const s3 =
    /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(
      host,
    );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    (!r2 && !r2Virtual && !s3)
  )
    throw new Error(
      "Release upload URL must target trusted R2 or AWS S3 HTTPS storage",
    );
  const bucketPath = `/${configuration.bucket}/${object.key}`;
  const virtualPath = `/${object.key}`;
  if (
    !((r2 || s3) && url.pathname === bucketPath) &&
    !(
      (r2Virtual || (s3 && host.startsWith(`${configuration.bucket}.`))) &&
      url.pathname === virtualPath
    )
  )
    throw new Error(
      "Release upload URL does not match the configured bucket and object",
    );
  if (
    url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !/^[a-fA-F0-9]{64}$/.test(url.searchParams.get("X-Amz-Signature") ?? "") ||
    !url.searchParams.get("X-Amz-Credential")
  )
    throw new Error("Release upload URL must contain an S3 request signature");
  const expires = Date.parse(raw.expires_at);
  const seconds = Number(url.searchParams.get("X-Amz-Expires"));
  if (
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 16 * 60_000 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 900
  )
    throw new Error(
      "Release upload authorization is expired or has an unsafe lifetime",
    );
  return url;
}

function uploadHeaders(raw, object, condition, url) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Release upload authorization headers are invalid");
  const headers = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (
      !SAFE_HEADERS.has(key) ||
      key in headers ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    )
      throw new Error("Release upload authorization contains unsafe headers");
    headers[key] = value;
  }
  const expected = {
    "content-length": String(object.size),
    "content-type": object.contentType,
    "cache-control": object.mutable
      ? "no-cache, max-age=0, must-revalidate"
      : "public, max-age=31536000, immutable",
    "x-amz-meta-sha256": object.sha256,
    "x-amz-meta-sha512": object.sha512,
    "x-amz-meta-milocode-version": object.version,
    ...(condition.ifMatch
      ? { "if-match": condition.ifMatch }
      : { "if-none-match": "*" }),
  };
  if (
    (condition.ifMatch && headers["if-none-match"]) ||
    (!condition.ifMatch && headers["if-match"]) ||
    Object.entries(expected).some(([name, value]) => headers[name] !== value)
  )
    throw new Error(
      "Release upload authorization does not bind the expected object and condition",
    );
  if (
    headers["x-amz-content-sha256"] &&
    ![object.sha256, "UNSIGNED-PAYLOAD"].includes(
      headers["x-amz-content-sha256"],
    )
  )
    throw new Error("Release upload payload checksum is inconsistent");
  if (
    headers["x-amz-checksum-sha256"] &&
    headers["x-amz-checksum-sha256"] !==
      Buffer.from(object.sha256, "hex").toString("base64")
  )
    throw new Error("Release upload payload checksum is inconsistent");
  const signed = new Set(
    (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";"),
  );
  if (
    !signed.has("host") ||
    Object.keys(expected).some((name) => !signed.has(name))
  )
    throw new Error("Release upload signature does not bind required headers");
  return headers;
}

export function createAdminReleaseClient({
  apiUrl,
  token,
  adminKey,
  fetchImpl = fetch,
}) {
  const root = apiRoot(apiUrl);
  if (
    [token, adminKey].some(
      (value) => value != null && typeof value !== "string",
    )
  )
    throw new Error("A valid administrator credential is required");
  const sessionToken = token?.trim();
  const existingKey = adminKey?.trim();
  if (Boolean(sessionToken) === Boolean(existingKey))
    throw new Error(
      "Provide exactly one administrator session token or existing administrator Key",
    );
  if (/\s/.test(sessionToken || existingKey))
    throw new Error("A valid administrator credential is required");
  // 复用后台现有管理员鉴权；凭据仅属于本 origin 的请求，上传和公网校验不继承此 header。
  const credentialHeader = sessionToken
    ? { authorization: `Bearer ${sessionToken}` }
    : { "x-api-key": existingKey };
  let configuration;
  async function request(suffix, body) {
    let response;
    try {
      response = await fetchImpl(
        new URL(`${root.href}${suffix ? `/${suffix}` : ""}`),
        {
          method: body ? "POST" : "GET",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
          headers: {
            ...credentialHeader,
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    } catch {
      throw new Error(
        "Release administrator API is unavailable; no upload was authorized",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401)
        throw new Error(
          sessionToken
            ? "Administrator session expired; sign in again before publishing"
            : "Administrator credential is invalid; verify the existing administrator Key before publishing",
        );
      if (response.status === 403)
        throw new Error(
          "Administrator permission or step-up verification is required; use a verified administrator session when step-up is enabled. This gate cannot be bypassed",
        );
      throw new Error(
        `Release administrator API request failed (${response.status})`,
      );
    }
    let result;
    try {
      const text = await response.text();
      if (text.length > 64 * 1024) throw new Error();
      result = JSON.parse(text);
    } catch {
      throw new Error("Release administrator API returned invalid metadata");
    }
    if (result?.code !== 0 || !result.data || typeof result.data !== "object")
      throw new Error(
        "Release administrator API did not authorize the operation",
      );
    return result.data;
  }
  return {
    async validateConfiguration(plan) {
      configuration = undefined;
      const data = await request("");
      if (
        data.configured !== true ||
        typeof data.bucket !== "string" ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(data.bucket)
      )
        throw new Error(
          "Configure desktop release storage in Sub2API before publishing",
        );
      if (data.release_base_url !== plan.baseUrl)
        throw new Error(
          "Sub2API release base URL differs from the signed release plan; rebuild or correct configuration before publishing",
        );
      configuration = data;
    },
    async head(key) {
      if (!configuration)
        throw new Error(
          "Release storage configuration must be validated first",
        );
      const data = await request("objects/head", { key });
      if (data.exists === false) return null;
      if (
        data.exists !== true ||
        !Number.isSafeInteger(data.size) ||
        data.size < 0
      )
        throw new Error("Release object metadata is invalid");
      if (
        [data.sha512, data.version, data.etag].some(
          (value) => value != null && typeof value !== "string",
        )
      )
        throw new Error("Release object metadata is invalid");
      return {
        size: data.size,
        sha512: data.sha512 ?? null,
        version: data.version ?? null,
        etag: data.etag ?? null,
      };
    },
    async put(object, condition) {
      if (!configuration)
        throw new Error(
          "Release storage configuration must be validated first",
        );
      const raw = await request("uploads", {
        key: object.key,
        size: object.size,
        content_type: object.contentType,
        sha256: object.sha256,
        sha512: object.sha512,
        version: object.version,
        ...(condition.ifMatch
          ? { if_match: condition.ifMatch }
          : { if_none_match: "*" }),
      });
      const url = uploadTarget(raw, object, configuration);
      const headers = uploadHeaders(raw.headers, object, condition, url);
      let response;
      const source = createReadStream(object.absolutePath);
      const digest = createHash("sha256");
      let uploadedBytes = 0;
      async function* payload() {
        for await (const chunk of source) {
          uploadedBytes += chunk.length;
          digest.update(chunk);
          yield chunk;
        }
      }
      try {
        response = await fetchImpl(url, {
          method: "PUT",
          headers,
          body: payload(),
          duplex: "half",
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(15 * 60_000),
        });
      } catch {
        throw new Error(
          "Direct release upload failed; no administrator credential was sent to storage",
        );
      } finally {
        source.destroy();
      }
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(
          response.status === 409 || response.status === 412
            ? "Release object changed concurrently; inspect the remote version before retrying"
            : `Direct release upload failed (${response.status})`,
        );
      // 预检和流式读取之间文件仍可能被替换；不得仅依赖可伪装成旧值的对象 metadata。
      if (
        uploadedBytes !== object.size ||
        digest.digest("hex") !== object.sha256
      )
        throw new Error(
          "Local release file changed during upload; do not advance the feed",
        );
    },
    verifyPublic: (object) => verifyPublicReleaseObject(object, fetchImpl),
  };
}

export function releaseStorageClientFromEnv(env = process.env) {
  const hasAdmin = ADMIN_FIELDS.some((field) => env[field]?.trim());
  const hasS3 = S3_FIELDS.some((field) => env[field]?.trim());
  if (hasAdmin && hasS3)
    throw new Error(
      "Choose either administrator-authorized release storage or direct S3 credentials; mixed configuration is not allowed",
    );
  if (!hasAdmin) return releaseS3ClientFromEnv(env);
  const missing = [];
  if (!env.MILOCODE_RELEASE_ADMIN_API_URL?.trim())
    missing.push("MILOCODE_RELEASE_ADMIN_API_URL");
  if (
    !env.MILOCODE_RELEASE_ADMIN_TOKEN?.trim() &&
    !env.MILOCODE_RELEASE_ADMIN_KEY?.trim()
  )
    missing.push("MILOCODE_RELEASE_ADMIN_TOKEN or MILOCODE_RELEASE_ADMIN_KEY");
  if (missing.length)
    throw new Error(
      `Missing release administrator configuration: ${missing.join(", ")}`,
    );
  return createAdminReleaseClient({
    apiUrl: env.MILOCODE_RELEASE_ADMIN_API_URL.trim(),
    token: env.MILOCODE_RELEASE_ADMIN_TOKEN?.trim(),
    adminKey: env.MILOCODE_RELEASE_ADMIN_KEY?.trim(),
  });
}
