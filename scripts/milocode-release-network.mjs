// 公开下载检查不携带管理员或 S3 凭据；只在资源可下载后推进 stable feed。
import { createHash } from "node:crypto";

export async function verifyPublicReleaseObject(object, fetchImpl = fetch) {
  const options = { redirect: "error", signal: AbortSignal.timeout(30_000) };
  let head;
  try {
    head = await fetchImpl(object.publicUrl, {
      ...options,
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
    });
  } catch {
    throw new Error("Public release URL is unavailable; do not advance the feed");
  }
  if (!head.ok || Number(head.headers.get("content-length")) !== object.size)
    throw new Error("Public release URL length check failed; do not advance the feed");
  let range;
  try {
    range = await fetchImpl(object.publicUrl, {
      ...options,
      headers: { range: "bytes=0-0", "accept-encoding": "identity" },
    });
  } catch {
    throw new Error("Public release Range check failed; do not advance the feed");
  }
  const valid =
    range.status === 206 && range.headers.get("content-range") === `bytes 0-0/${object.size}`;
  await range.body?.cancel();
  if (!valid)
    throw new Error("Public release URL must support HTTP Range; do not advance the feed");
  // CDN 的长度与 metadata 不能证明实际下载内容正确；发布机只读一次整包，流式验 SHA512。
  let download;
  try {
    download = await fetchImpl(object.publicUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15 * 60_000),
      headers: { "accept-encoding": "identity" },
    });
    if (
      download.status !== 200 ||
      !download.body ||
      ![null, "identity"].includes(download.headers.get("content-encoding"))
    )
      throw new Error();
    const hash = createHash("sha512");
    let size = 0;
    for await (const chunk of download.body) {
      size += chunk.length;
      if (size > object.size) throw new Error();
      hash.update(chunk);
    }
    if (size !== object.size || hash.digest("base64") !== object.sha512) throw new Error();
  } catch {
    try {
      await download?.body?.cancel();
    } catch {
      /* stream may already have failed or closed */
    }
    throw new Error("Public release bytes failed the size/SHA512 check; do not advance the feed");
  }
}
