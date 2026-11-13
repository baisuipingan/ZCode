import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFileLock } from "@zcode/shared/node";
import { BRAND_ACCOUNT_CIPHER_TIMEOUT_MS } from "@zcode/shared";
import { setTimeout as delay } from "node:timers/promises";
import { failure, safeFailure } from "./errors.js";

export interface PrivateSession {
  version: 1;
  origin: string;
  epoch: number;
  revision: string;
  credentials: {
    accessToken: string;
    refreshToken?: string;
    userId: number;
    expiresAt: number | null;
  } | null;
  /** 刷新超时可能已消费旧 token，禁止自动无限重放。 */
  refreshUncertain: boolean;
}

export interface SecretRepoOptions {
  filePath: string;
  origin: string;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}

export function createSecretRepo(options: SecretRepoOptions) {
  let disposed = false;

  async function cipher(operation: () => Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<string>((_, reject) => {
          timer = setTimeout(
            () => reject(failure("storage_unavailable")),
            BRAND_ACCOUNT_CIPHER_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function read(): Promise<PrivateSession> {
    try {
      const outer = JSON.parse(await readFile(options.filePath, "utf8"));
      if (outer.version !== 1 || typeof outer.ciphertext !== "string")
        throw failure("storage_unavailable");
      const session = JSON.parse(
        await cipher(() => options.decrypt(outer.ciphertext)),
      ) as PrivateSession;
      const credentials = session.credentials;
      if (
        session.version !== 1 ||
        session.origin !== options.origin ||
        !Number.isSafeInteger(session.epoch) ||
        session.epoch < 0 ||
        typeof session.revision !== "string" ||
        typeof session.refreshUncertain !== "boolean" ||
        (credentials !== null &&
          (!credentials ||
            typeof credentials.accessToken !== "string" ||
            !credentials.accessToken ||
            !Number.isSafeInteger(credentials.userId) ||
            credentials.userId < 1 ||
            (credentials.refreshToken !== undefined &&
              typeof credentials.refreshToken !== "string") ||
            (credentials.expiresAt !== null && !Number.isFinite(credentials.expiresAt))))
      )
        throw failure("storage_unavailable");
      return session;
    } catch (error) {
      if (isMissing(error))
        return {
          version: 1,
          origin: options.origin,
          epoch: 0,
          revision: "",
          credentials: null,
          refreshUncertain: false,
        };
      throw failure("storage_unavailable");
    }
  }

  async function write(
    session: PrivateSession,
    canCommit: () => boolean = () => true,
  ): Promise<PrivateSession> {
    const assertCurrent = () => {
      if (disposed) throw failure("storage_unavailable");
      if (!canCommit()) throw failure("session_changed");
    };
    assertCurrent();
    const next = { ...session, revision: randomUUID() };
    const temporary = `${options.filePath}.${randomUUID()}.tmp`;
    try {
      const ciphertext = await cipher(() => options.encrypt(JSON.stringify(next)));
      if (!ciphertext) throw failure("storage_unavailable");
      // 首次系统授权可能较慢；期间取消/换号后，迟到密文不能写入旧凭据。
      assertCurrent();
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, ciphertext }));
        await file.sync();
      } finally {
        await file.close();
      }
      // 原因：分别写 access/refresh 会在崩溃或双窗口读取时产生错配；同文件原子替换整对材料。
      for (let attempt = 0; ; attempt += 1) {
        assertCurrent();
        try {
          await rename(temporary, options.filePath);
          break;
        } catch (error) {
          const pause = [50, 100, 200, 400, 800][attempt];
          if (
            pause === undefined ||
            !["EPERM", "EBUSY", "EACCES"].includes((error as { code?: string })?.code ?? "")
          )
            throw error;
          await delay(pause);
        }
      }
      return next;
    } catch (error) {
      if (safeFailure(error).code === "session_changed") throw failure("session_changed");
      throw failure("storage_unavailable");
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function withLock<T>(action: () => Promise<T>): Promise<T> {
    try {
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
    } catch {
      throw failure("storage_unavailable");
    }
    if (disposed) throw failure("busy");
    let release: () => Promise<void>;
    try {
      // 40秒仅限制锁争用；首次系统授权可更久，其他窗口收到busy重试，不抢占活owner或绕锁换证。
      release = await acquireFileLock(options.filePath, [25, 50, 100, 200], 1_000, 40_000);
    } catch (error) {
      throw failure(
        (error as { code?: string })?.code === "ZCODE_FILE_LOCK_TIMEOUT"
          ? "busy"
          : "storage_unavailable",
      );
    }
    try {
      if (disposed) throw failure("busy");
      return await action();
    } finally {
      await release();
    }
  }

  function watch(onChange: () => void): () => void {
    const listener = () => onChange();
    watchFile(options.filePath, { persistent: false, interval: 500 }, listener);
    return () => unwatchFile(options.filePath, listener);
  }

  return {
    read,
    write,
    withLock,
    watch,
    dispose: () => {
      disposed = true;
    },
  };
}
