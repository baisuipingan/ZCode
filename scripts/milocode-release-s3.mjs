import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { verifyPublicReleaseObject } from "./milocode-release-network.mjs";

const EMPTY_SHA256 = createHash("sha256").digest("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encodePart = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function signS3Request({
  method,
  url,
  region,
  accessKeyId,
  secretAccessKey,
  payloadSha256,
  headers = {},
  date = new Date(),
}) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const signed = {
    ...Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    host: url.host,
    "x-amz-content-sha256": payloadSha256,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(signed)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(signed[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [encodePart(key), encodePart(value)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    names.join(";"),
    payloadSha256,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hash(canonicalRequest)}`)
    .digest("hex");
  return {
    ...signed,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export function createS3Client({
  endpoint,
  bucket,
  region = "auto",
  accessKeyId,
  secretAccessKey,
  fetchImpl = fetch,
}) {
  let origin;
  try {
    origin = new URL(endpoint);
  } catch {
    throw new Error("S3 endpoint must be an HTTPS URL");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("S3 endpoint must be an HTTPS origin without credentials, path or query");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? ""))
    throw new Error("Invalid release bucket name");
  if (!accessKeyId || !secretAccessKey) throw new Error("Release S3 credentials are missing");
  function objectUrl(key) {
    if (
      !key ||
      key.startsWith("/") ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Invalid release object key");
    }
    return new URL(`${encodePart(bucket)}/${key.split("/").map(encodePart).join("/")}`, origin);
  }
  async function request(method, key, payloadSha256 = EMPTY_SHA256, headers = {}, body) {
    const url = objectUrl(key);
    return fetchImpl(url, {
      method,
      headers: signS3Request({
        method,
        url,
        region,
        accessKeyId,
        secretAccessKey,
        payloadSha256,
        headers,
      }),
      body,
      ...(body ? { duplex: "half" } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(method === "PUT" ? 15 * 60_000 : 30_000),
    });
  }
  return {
    verifyPublic: (object) => verifyPublicReleaseObject(object, fetchImpl),
    async head(key) {
      const response = await request("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Release object HEAD failed (${response.status})`);
      return {
        size: Number(response.headers.get("content-length")),
        sha512: response.headers.get("x-amz-meta-sha512"),
        version: response.headers.get("x-amz-meta-milocode-version"),
        etag: response.headers.get("etag"),
      };
    },
    async put(object, condition) {
      const response = await request(
        "PUT",
        object.key,
        object.sha256,
        {
          "content-type": object.contentType,
          "content-length": String(object.size),
          "cache-control": object.mutable
            ? "no-cache, max-age=0, must-revalidate"
            : "public, max-age=31536000, immutable",
          "x-amz-meta-sha512": object.sha512,
          "x-amz-meta-milocode-version": object.version,
          ...(condition.ifNoneMatch ? { "if-none-match": condition.ifNoneMatch } : {}),
          ...(condition.ifMatch ? { "if-match": condition.ifMatch } : {}),
        },
        createReadStream(object.absolutePath),
      );
      // 不把 S3 错误正文或响应头写入日志，避免服务返回敏感诊断信息。
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(
          response.status === 412 || response.status === 409
            ? "Release object changed concurrently; inspect remote version before retrying"
            : `Release object upload failed (${response.status})`,
        );
      }
    },
  };
}

export function releaseS3ClientFromEnv(env = process.env) {
  const required = [
    "MILOCODE_RELEASE_S3_ENDPOINT",
    "MILOCODE_RELEASE_BUCKET",
    "MILOCODE_RELEASE_S3_ACCESS_KEY_ID",
    "MILOCODE_RELEASE_S3_SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new Error(`Missing release storage configuration: ${missing.join(", ")}`);
  return createS3Client({
    endpoint: env.MILOCODE_RELEASE_S3_ENDPOINT.trim(),
    bucket: env.MILOCODE_RELEASE_BUCKET.trim(),
    region: env.MILOCODE_RELEASE_S3_REGION?.trim() || "auto",
    accessKeyId: env.MILOCODE_RELEASE_S3_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.MILOCODE_RELEASE_S3_SECRET_ACCESS_KEY,
  });
}
