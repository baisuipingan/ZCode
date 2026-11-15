import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  signMiloCodeRelease,
  verifyMiloCodeRelease,
} from "../packages/desktop/scripts/milocode-release-trust.mjs";
import { releaseStorageClientFromEnv } from "./milocode-release-admin.mjs";

const runFile = promisify(execFile);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseRoot(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Release base URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/")
  ) {
    throw new Error(
      "Release base URL must be HTTPS, end in slash and contain no credentials or query",
    );
  }
  return url;
}

function validVersion(version) {
  if (!VERSION.test(version ?? ""))
    throw new Error("Release version must be stable major.minor.patch");
  return version;
}

function compareVersion(a, b) {
  validVersion(a);
  validVersion(b);
  const ap = a.split(".").map(BigInt);
  const bp = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i += 1) if (ap[i] !== bp[i]) return ap[i] > bp[i] ? 1 : -1;
  return 0;
}

async function hashes(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0)
    throw new Error("Release input must be a non-empty regular file");
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {
    size: info.size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

function objectKey(url) {
  const key = decodeURIComponent(url.pathname.slice(1));
  if (
    !key ||
    key.split("/").some((part) => !part || part === "." || part === "..") ||
    [...key].some((character) => character === "\\" || character.charCodeAt(0) < 32)
  ) {
    throw new Error("Release URL produces an unsafe object key");
  }
  return key;
}

function releaseObjectContentType(item, version) {
  const platform = item.platform;
  const prefix = `releases/${version}/${platform}/MiloCode-${version}-`;
  if (platform === "win32-x64") {
    if (item.mutable)
      return item.localPath === `stable/${platform}/latest.json` ? "application/json" : undefined;
    return [`${prefix}win-x64.exe`, `${prefix}win-x64.exe.blockmap`].includes(item.localPath)
      ? "application/octet-stream"
      : undefined;
  }
  if (!["darwin-arm64", "darwin-x64"].includes(platform)) return undefined;
  if (item.mutable)
    return item.localPath === `stable/${platform}/appcast.xml` ? "application/xml" : undefined;
  const name = `${prefix}mac-${platform.slice("darwin-".length)}`;
  if (item.localPath === `${name}.zip`) return "application/zip";
  if (item.localPath === `${name}.dmg`) return "application/x-apple-diskimage";
  return undefined;
}

export async function prepareRelease(options) {
  const version = validVersion(options.version);
  const base = releaseRoot(options.baseUrl);
  if (!options.windows && !options.mac && !options.macX64)
    throw new Error("At least one release platform is required");
  const releaseDate = new Date(options.releaseDate ?? Date.now()).toISOString();
  const outputDir = resolve(options.outputDir);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir, { recursive: false });
  const plan = {
    schemaVersion: 1,
    productId: "app.milo.code",
    version,
    baseUrl: base.href,
    objects: [],
  };
  const notes = options.releaseNotes ?? "";
  async function add(localPath, mutable, contentType, platform) {
    const url = new URL(localPath, base);
    const object = {
      key: objectKey(url),
      localPath,
      publicUrl: url.href,
      mutable,
      contentType,
      platform,
      ...(await hashes(join(outputDir, localPath))),
    };
    plan.objects.push(object);
    return object;
  }
  async function stage(source, localPath, contentType, platform) {
    await hashes(source);
    const target = join(outputDir, localPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return add(localPath, false, contentType, platform);
  }
  try {
    if (options.windows) {
      const win = options.windows;
      const path = `releases/${version}/win32-x64/MiloCode-${version}-win-x64.exe`;
      const installer = await stage(win.installer, path, "application/octet-stream", "win32-x64");
      if (win.blockmap)
        await stage(win.blockmap, `${path}.blockmap`, "application/octet-stream", "win32-x64");
      const keyInfo = await lstat(win.privateKeyFile);
      if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077) !== 0) {
        throw new Error("Windows release private key must be a private regular file (0600)");
      }
      const privateKey = createPrivateKey(await readFile(win.privateKeyFile));
      if (privateKey.asymmetricKeyType !== "ed25519")
        throw new Error("Windows release key must be Ed25519");
      const payload = {
        schemaVersion: 1,
        productId: plan.productId,
        platform: "win32-x64",
        channel: "stable",
        version,
        releaseDate,
        ...(notes ? { releaseNotes: notes } : {}),
        files: [
          {
            url: installer.publicUrl,
            sha512: installer.sha512,
            size: installer.size,
          },
        ],
      };
      const envelope = signMiloCodeRelease(payload, {
        keyId: win.keyId,
        privateKey,
      });
      const publicKeys = {
        [win.keyId]: createPublicKey(privateKey).export({
          format: "pem",
          type: "spki",
        }),
      };
      const feedPath = "stable/win32-x64/latest.json";
      verifyMiloCodeRelease(envelope, {
        manifestUrl: new URL(feedPath, base).href,
        releaseBaseUrl: base.href,
        publicKeys,
        productId: plan.productId,
        platform: "win32-x64",
      });
      await mkdir(dirname(join(outputDir, feedPath)), { recursive: true });
      await writeFile(join(outputDir, feedPath), envelope, { flag: "wx" });
      await add(feedPath, true, "application/json", "win32-x64");
      plan.windowsPublicKeys = publicKeys;
    }
    for (const [arch, mac] of [
      ["arm64", options.mac],
      ["x64", options.macX64],
    ]) {
      if (!mac) continue;
      const platform = `darwin-${arch}`;
      const archivePath = `releases/${version}/${platform}/MiloCode-${version}-mac-${arch}.zip`;
      const archive = await stage(mac.archive, archivePath, "application/zip", platform);
      const tool = await lstat(mac.generateAppcast);
      if (!tool.isFile() || tool.isSymbolicLink())
        throw new Error("Sparkle generate_appcast must be a regular executable file");
      const signUpdate = join(dirname(resolve(mac.generateAppcast)), "sign_update");
      const signer = await lstat(signUpdate);
      if (!signer.isFile() || signer.isSymbolicLink())
        throw new Error("The matching Sparkle sign_update tool is required");
      const feedPath = `stable/${platform}/appcast.xml`;
      await mkdir(dirname(join(outputDir, feedPath)), { recursive: true });
      if (notes)
        await writeFile(join(outputDir, archivePath.replace(/\.zip$/, ".md")), notes, {
          flag: "wx",
        });
      const args = [
        "--maximum-deltas",
        "0",
        "--maximum-versions",
        "1",
        "--versions",
        version,
        "--download-url-prefix",
        new URL(dirname(archivePath).replaceAll(sep, "/") + "/", base).href,
        "--embed-release-notes",
        "-o",
        join(outputDir, feedPath),
      ];
      const signingArgs = [];
      if (mac.edKeyFile) {
        const keyInfo = await lstat(mac.edKeyFile);
        if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077) !== 0) {
          throw new Error("Sparkle key file must be a private regular file (0600)");
        }
        signingArgs.push("--ed-key-file", resolve(mac.edKeyFile));
      } else {
        if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(mac.account ?? ""))
          throw new Error("A dedicated Sparkle keychain account is required");
        signingArgs.push("--account", mac.account);
      }
      args.push(...signingArgs);
      args.push(join(outputDir, dirname(archivePath)));
      try {
        await runFile(mac.generateAppcast, args, {
          timeout: 10 * 60_000,
          maxBuffer: 1024 * 1024,
        });
        // 归档签名与 feed 签名是不同层；显式签 feed，不能假定生成器一定替它签名。
        await runFile(signUpdate, [...signingArgs, join(outputDir, feedPath)]);
        await runFile(signUpdate, [...signingArgs, "--verify", join(outputDir, feedPath)]);
      } catch {
        throw new Error(
          "Sparkle appcast signing failed; inspect the official tool locally without printing private key material",
        );
      }
      const xml = await readFile(join(outputDir, feedPath), "utf8");
      const enclosure = xml.match(/<enclosure\s[^>]*>/)?.[0] ?? "";
      const archiveSignature = enclosure.match(/sparkle:edSignature="([A-Za-z0-9+/=]+)"/)?.[1];
      if (
        !archiveSignature ||
        !enclosure.includes(`url="${archive.publicUrl}"`) ||
        !enclosure.includes(`length="${archive.size}"`) ||
        !(
          xml.includes(`sparkle:version="${version}"`) ||
          xml.includes(`<sparkle:version>${version}</sparkle:version>`)
        )
      ) {
        throw new Error("Sparkle generated feed has no signed archive for the expected version");
      }
      await runFile(signUpdate, [
        ...signingArgs,
        "--verify",
        join(outputDir, archivePath),
        archiveSignature,
      ]);
      await add(feedPath, true, "application/xml", platform);
      // appcast 只从 ZIP 生成，DMG 仅用于首次手动安装，不能让生成器选到另一个格式。
      if (mac.dmg)
        await stage(
          mac.dmg,
          `releases/${version}/${platform}/MiloCode-${version}-mac-${arch}.dmg`,
          "application/x-apple-diskimage",
          platform,
        );
    }
    plan.objects.sort((a, b) => Number(a.mutable) - Number(b.mutable));
    await writeFile(join(outputDir, "release-plan.json"), JSON.stringify(plan, null, 2) + "\n", {
      flag: "wx",
    });
    return plan;
  } catch (error) {
    // 输出目录由本次 mkdir 独占创建；失败时移除半成品，避免被误当成可发布版本。
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function validateReleasePlan(dir) {
  const root = resolve(dir);
  const text = await readFile(join(root, "release-plan.json"), "utf8");
  if (text.length > 1024 * 1024) throw new Error("Release plan is too large");
  const plan = JSON.parse(text);
  validVersion(plan.version);
  const base = releaseRoot(plan.baseUrl);
  if (
    plan.schemaVersion !== 1 ||
    plan.productId !== "app.milo.code" ||
    !Array.isArray(plan.objects) ||
    !plan.objects.length ||
    plan.objects.length > 30
  )
    throw new Error("Invalid release plan");
  const seen = new Set();
  const objects = [];
  for (const item of plan.objects) {
    if (
      typeof item.localPath !== "string" ||
      !item.localPath ||
      item.localPath.includes("\\") ||
      typeof item.mutable !== "boolean"
    )
      throw new Error("Invalid release plan object path");
    const absolutePath = resolve(root, item.localPath);
    if (relative(root, absolutePath).startsWith("..") || absolutePath === root)
      throw new Error("Unsafe release plan object path");
    const expected = new URL(item.localPath, base);
    if (expected.href !== item.publicUrl || objectKey(expected) !== item.key || seen.has(item.key))
      throw new Error("Invalid or duplicate release object key");
    const requiredPrefix = item.mutable
      ? `stable/${item.platform}/`
      : `releases/${plan.version}/${item.platform}/`;
    const expectedContentType = releaseObjectContentType(item, plan.version);
    if (
      !expectedContentType ||
      item.contentType !== expectedContentType ||
      !item.localPath.startsWith(requiredPrefix)
    )
      throw new Error("Release object is outside its platform/version path or format");
    seen.add(item.key);
    const actual = await hashes(absolutePath);
    if (actual.size !== item.size || actual.sha256 !== item.sha256 || actual.sha512 !== item.sha512)
      throw new Error("Staged release file changed: size or checksum mismatch");
    objects.push({ ...item, absolutePath, version: plan.version });
  }
  const winFeed = objects.find((item) => item.localPath === "stable/win32-x64/latest.json");
  if (winFeed)
    verifyMiloCodeRelease(await readFile(winFeed.absolutePath, "utf8"), {
      manifestUrl: winFeed.publicUrl,
      releaseBaseUrl: base.href,
      publicKeys: plan.windowsPublicKeys,
      productId: plan.productId,
      platform: "win32-x64",
    });
  for (const platform of ["darwin-arm64", "darwin-x64"]) {
    const macObjects = objects.filter((item) => item.platform === platform);
    if (!macObjects.length) continue;
    const feed = macObjects.find((item) => item.mutable);
    const archive = macObjects.find((item) => item.contentType === "application/zip");
    if (!feed || !archive) throw new Error("Mac release requires its own feed and ZIP archive");
    const xml = await readFile(feed.absolutePath, "utf8");
    const enclosure = xml.match(/<enclosure\s[^>]*>/)?.[0] ?? "";
    // 根因：两个 Mac 架构共用一个发布工具；计划复核必须将 feed 绑定到同架构 ZIP，
    // 不能仅凭 platform 字段和文件哈希把错误架构的更新链接发布出去。
    if (
      !enclosure.includes(`url="${archive.publicUrl}"`) ||
      !enclosure.includes(`length="${archive.size}"`) ||
      !/sparkle:edSignature="[A-Za-z0-9+/=]+"/.test(enclosure)
    )
      throw new Error("Mac feed must reference its own platform ZIP archive");
  }
  objects.sort((a, b) => Number(a.mutable) - Number(b.mutable));
  return { ...plan, objects };
}

export async function publishRelease({ dir, dryRun = false, client, env }) {
  const plan = await validateReleasePlan(dir);
  const summary = plan.objects.map(({ key, size, mutable, publicUrl }) => ({
    key,
    size,
    mutable,
    publicUrl,
  }));
  if (dryRun) return { dryRun: true, version: plan.version, objects: summary };
  const storage = client ?? releaseStorageClientFromEnv(env);
  await storage.validateConfiguration?.(plan);
  // 先预检所有对象，避免明知存在版本冲突时仍上传其他资源。
  const prior = new Map();
  for (const item of plan.objects) {
    const existing = await storage.head(item.key);
    prior.set(item.key, existing);
    if (!existing || (existing.size === item.size && existing.sha512 === item.sha512)) continue;
    if (!item.mutable)
      throw new Error(
        "Immutable release object conflict; the same version cannot contain different bytes",
      );
    if (!existing.version || !existing.etag)
      throw new Error(
        "Existing feed has no trusted version metadata; inspect it before publishing",
      );
    const comparison = compareVersion(existing.version, plan.version);
    if (comparison > 0) throw new Error("Refusing release feed downgrade");
    if (comparison === 0)
      throw new Error("Release feed conflict: same version has different bytes");
  }
  for (const item of plan.objects) {
    const existing = prior.get(item.key);
    if (!existing || existing.size !== item.size || existing.sha512 !== item.sha512) {
      await storage.put(item, existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" });
      const saved = await storage.head(item.key);
      if (!saved || saved.size !== item.size || saved.sha512 !== item.sha512)
        throw new Error(
          "Uploaded release object verification failed; feeds were not advanced further",
        );
    }
    if (storage.verifyPublic) await storage.verifyPublic(item);
  }
  return { dryRun: false, version: plan.version, objects: summary };
}
