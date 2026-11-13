import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function createReleaseKeys({ keyId, keyDir }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyId ?? "")) {
    throw new Error(
      "keyId must start with a lowercase letter or number and use at most 64 lowercase letters, numbers, dots, underscores or hyphens",
    );
  }
  const dir = resolve(
    keyDir ?? join(homedir(), "Library/Application Support/MiloCode/ReleaseKeys"),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Release key directory must be a private directory with mode 0700");
  }
  const privateKeyFile = join(dir, `${keyId}.private.pem`);
  const publicKeyFile = join(dir, `${keyId}.public.pem`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await writeFile(publicKeyFile, publicPem, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // 公钥冲突时只删除这次刚生成的私钥，绝不替换已有发布身份。
    await rm(privateKeyFile, { force: true });
    throw error;
  }
  return {
    keyId,
    privateKeyFile,
    publicKeyFile,
    publicKeysJson: JSON.stringify({ [keyId]: publicPem }),
    backupRequired: true,
  };
}
