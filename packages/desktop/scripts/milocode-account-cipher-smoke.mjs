// 可重复的进程桥/文件工程验收：执行真实源函数，不启动App、不访问用户钥匙串。
// pnpm exec tsx packages/desktop/scripts/milocode-account-cipher-smoke.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { BRAND_ACCOUNT_CIPHER_TIMEOUT_MS } from "@zcode/shared";
import { createSecretRepo } from "../../services/src/brand-account/secretRepo.ts";

const root = resolve(import.meta.dirname, "../../..");
const mainSource = await readFile(
  join(root, "packages/desktop/src/main/desktopHostProcess.ts"),
  "utf8",
);
const hostSource = await readFile(join(root, "packages/desktop/src/host/index.ts"), "utf8");
const serviceSource = await readFile(
  join(root, "packages/services/src/brand-account/service.ts"),
  "utf8",
);

function sourceNode(source, matches) {
  const ast = ts.createSourceFile("cipher.ts", source, ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if (!found && matches(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, "real source boundary must exist");
  return found.getText(ast);
}
function sourceFunction(source, name) {
  return sourceNode(source, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
}
function messageBranch(source, condition) {
  return sourceNode(
    source,
    (node) => ts.isIfStatement(node) && node.expression.getText() === condition,
  );
}
function runSource(source, sandbox) {
  vm.runInContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    sandbox,
  );
}
function latch() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const mainBranch = messageBranch(
  mainSource,
  "result.data.type === HostResponseTypes.BrandAccountCipherRequest",
);
const hostBranch = messageBranch(
  hostSource,
  "msg.type === HostMessageTypes.BrandAccountCipherResult",
);

function mainFixture({
  platform = "darwin",
  available = true,
  backend = "gnome_libsecret",
  encryption,
  decryption,
} = {}) {
  const child = {};
  const replies = [];
  child.postMessage = (message) => replies.push(message);
  const exitedHostProcesses = new WeakSet();
  const disposingHostProcesses = new Set();
  const calls = [];
  const failSync = () => {
    throw new Error("synchronous OS cipher must never run");
  };
  const sandbox = vm.createContext({
    Buffer,
    child,
    exitedHostProcesses,
    disposingHostProcesses,
    process: { platform },
    HostResponseTypes: { BrandAccountCipherRequest: "brand-account-cipher-request" },
    HostMessageTypes: { BrandAccountCipherResult: "brand-account-cipher-result" },
    hostBrandAccountCipherResultMessageSchema: { parse: (value) => value },
    safeStorage: {
      isEncryptionAvailable: () => {
        if (platform !== "linux") return failSync();
        calls.push("available-sync");
        return available;
      },
      encryptString: (value) => {
        if (platform !== "linux") return failSync();
        calls.push("encrypt-sync");
        return Buffer.from(value);
      },
      decryptString: (value) => {
        if (platform !== "linux") return failSync();
        calls.push("decrypt-sync");
        return value.toString();
      },
      isAsyncEncryptionAvailable: async () => {
        assert.notEqual(platform, "linux", "Linux must not enter the async provider");
        calls.push("available");
        return available;
      },
      getSelectedStorageBackend: () => backend,
      encryptStringAsync: async (value) => {
        assert.notEqual(platform, "linux", "Linux must not enter the async provider");
        calls.push("encrypt");
        return encryption ? encryption(value) : Buffer.from(value);
      },
      decryptStringAsync: async (value) => {
        assert.notEqual(platform, "linux", "Linux must not enter the async provider");
        calls.push("decrypt");
        return decryption ? decryption(value) : { result: value.toString(), shouldReEncrypt: true };
      },
    },
  });
  runSource(
    `function dispatch(message) { const result = { data: message }; ${mainBranch} }`,
    sandbox,
  );
  return {
    calls,
    replies,
    child,
    exitedHostProcesses,
    disposingHostProcesses,
    dispatch: (operation = "encrypt", value = "SYNTHETIC_PRIVATE_VALUE") =>
      sandbox.dispatch({
        requestId: randomUUID(),
        operation,
        value,
        type: "brand-account-cipher-request",
      }),
  };
}

test("Main never blocks its dispatcher during first availability/encryption; old envelope uses async .result", async () => {
  const available = latch();
  const encrypt = latch();
  const fixture = mainFixture({
    available: available.promise,
    encryption: async (value) => {
      await encrypt.promise;
      return Buffer.from(value);
    },
  });
  assert.equal(fixture.dispatch(), undefined);
  let heartbeat = false;
  await delay(10).then(() => {
    heartbeat = true;
  });
  assert.equal(heartbeat, true);
  assert.deepEqual(fixture.calls, ["available"]);
  available.release(true);
  await flush();
  assert.deepEqual(fixture.calls, ["available", "encrypt"]);
  assert.equal(fixture.replies.length, 0);
  encrypt.release();
  await flush();
  assert.equal(fixture.replies[0].result.ok, true);
  const oldEnvelope = `os:v1:${Buffer.from("milorouter-account:v1:OLD_SYNCHRONOUS_FIXTURE").toString("base64")}`;
  fixture.dispatch("decrypt", oldEnvelope);
  await flush();
  assert.equal(fixture.replies[1].result.value, "OLD_SYNCHRONOUS_FIXTURE");
});

for (const stage of ["availability", "encrypt", "decrypt"]) {
  for (const lifecycle of ["disposing", "exited"]) {
    test(`Main fences ${lifecycle} child after awaited ${stage}`, async () => {
      const gate = latch();
      const fixture = mainFixture({
        available: stage === "availability" ? gate.promise : true,
        encryption:
          stage === "encrypt"
            ? async () => {
                await gate.promise;
                return Buffer.from("synthetic");
              }
            : undefined,
        decryption:
          stage === "decrypt"
            ? async () => {
                await gate.promise;
                return { result: "milorouter-account:v1:synthetic" };
              }
            : undefined,
      });
      fixture.dispatch(
        stage === "decrypt" ? "decrypt" : "encrypt",
        stage === "decrypt" ? `os:v1:${Buffer.from("legacy").toString("base64")}` : "synthetic",
      );
      await flush();
      (lifecycle === "disposing"
        ? fixture.disposingHostProcesses
        : fixture.exitedHostProcesses
      ).add(fixture.child);
      gate.release(true);
      await flush();
      assert.equal(fixture.replies.length, 0);
      if (stage === "availability") assert.deepEqual(fixture.calls, ["available"]);
    });
  }
}

test("Main fails closed on unavailable storage, Linux basic_text and invalid purpose", async () => {
  for (const options of [{ available: false }, { platform: "linux", backend: "basic_text" }]) {
    const fixture = mainFixture(options);
    fixture.dispatch();
    await flush();
    assert.equal(fixture.replies[0].result.errorCode, "secure_storage_unavailable");
    assert.deepEqual(fixture.calls, [
      options.platform === "linux" ? "available-sync" : "available",
    ]);
  }
  const fixture = mainFixture({ decryption: async () => ({ result: "UNRELATED_PRIVATE_VALUE" }) });
  fixture.dispatch("decrypt", `os:v1:${Buffer.from("legacy").toString("base64")}`);
  await flush();
  assert.equal(fixture.replies[0].result.errorCode, "secure_storage_failed");
  assert.doesNotMatch(JSON.stringify(fixture.replies), /PRIVATE_VALUE/);
});

test("Linux preserves its protected synchronous backend and never initializes the async fallback", async () => {
  const fixture = mainFixture({ platform: "linux" });
  fixture.dispatch();
  await flush();
  const encrypted = fixture.replies[0].result.value;
  fixture.dispatch("decrypt", encrypted);
  await flush();
  assert.equal(fixture.replies[1].result.value, "SYNTHETIC_PRIVATE_VALUE");
  assert.deepEqual(fixture.calls, [
    "available-sync",
    "encrypt-sync",
    "available-sync",
    "decrypt-sync",
  ]);
});

test("Host shares 120s budget, removes timed-out IDs and rejects disposed pending requests", async () => {
  const timers = [];
  const requests = [];
  const sandbox = vm.createContext({
    BRAND_ACCOUNT_CIPHER_TIMEOUT_MS,
    randomUUID,
    parentPort: { postMessage: (value) => requests.push(value) },
    HostMessageTypes: { BrandAccountCipherResult: "brand-account-cipher-result" },
    HostResponseTypes: { BrandAccountCipherRequest: "brand-account-cipher-request" },
    hostBrandAccountCipherRequestResponseSchema: { parse: (value) => value },
    setTimeout: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout() {},
  });
  runSource(
    `
    const pendingBrandAccountCipherRequests = new Map();
    let brandAccountCipherDisposed = false;
    let disposeBrandAccountService;
    let assertBrandInferenceConfigured;
    ${sourceFunction(hostSource, "brandAccountStorageError")}
    ${sourceFunction(hostSource, "requestBrandAccountCipher")}
    ${sourceFunction(hostSource, "disposeBrandAccount")}
    function accept(msg) { ${hostBranch} }
  `,
    sandbox,
  );
  assert.equal(BRAND_ACCOUNT_CIPHER_TIMEOUT_MS, 120_000);
  const timedOut = sandbox.requestBrandAccountCipher("encrypt", "synthetic");
  const timeoutAssertion = assert.rejects(timedOut, /unavailable/);
  assert.equal(timers[0].timeoutMs, BRAND_ACCOUNT_CIPHER_TIMEOUT_MS);
  timers[0].callback();
  await timeoutAssertion;
  sandbox.accept({
    requestId: requests[0].requestId,
    type: "brand-account-cipher-result",
    result: { ok: true, value: "late" },
  });
  const disposed = sandbox.requestBrandAccountCipher("encrypt", "synthetic");
  const disposedAssertion = assert.rejects(disposed, /unavailable/);
  sandbox.disposeBrandAccount();
  await disposedAssertion;
  sandbox.accept({
    requestId: requests[1].requestId,
    type: "brand-account-cipher-result",
    result: { ok: true, value: "late" },
  });
  await assert.rejects(sandbox.requestBrandAccountCipher("encrypt", "synthetic"), /unavailable/);
  assert.equal(requests.length, 2);
});

async function repoFixture(t, encrypt) {
  const directory = await mkdtemp(join(tmpdir(), "milocode-cipher-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "session.json");
  const original = JSON.stringify({ version: 1, ciphertext: "SYNTHETIC_OLD_FILE" });
  await writeFile(filePath, original, { mode: 0o600 });
  const repo = createSecretRepo({
    filePath,
    origin: "https://account.example.test",
    encrypt,
    decrypt: async (value) => Buffer.from(value, "base64").toString(),
  });
  t.after(repo.dispose);
  return {
    directory,
    filePath,
    original,
    repo,
    session: {
      version: 1,
      origin: "https://account.example.test",
      epoch: 3,
      revision: "",
      credentials: { accessToken: "SYNTHETIC_ACCESS", userId: 1, expiresAt: null },
      refreshUncertain: false,
    },
  };
}

test("Repo waits beyond the former 5s cipher deadline and atomically restores the encrypted pair", async (t) => {
  const fixture = await repoFixture(t, async (value) => {
    await delay(5_200);
    return Buffer.from(value).toString("base64");
  });
  await fixture.repo.withLock(() => fixture.repo.write(fixture.session));
  assert.equal((await fixture.repo.read()).credentials.accessToken, "SYNTHETIC_ACCESS");
  assert.doesNotMatch(await readFile(fixture.filePath, "utf8"), /SYNTHETIC_ACCESS/);
});

for (const invalidation of ["cancel", "dispose"]) {
  test(`Repo does not write late ciphertext after ${invalidation}`, async (t) => {
    const started = latch();
    const gate = latch();
    const fixture = await repoFixture(t, async () => {
      started.release();
      await gate.promise;
      return "LATE_SYNTHETIC_CIPHERTEXT";
    });
    let current = true;
    const write = fixture.repo.write(fixture.session, () => current);
    const rejected = assert.rejects(
      write,
      (error) =>
        error.code === (invalidation === "cancel" ? "session_changed" : "storage_unavailable"),
    );
    await started.promise;
    if (invalidation === "dispose") fixture.repo.dispose();
    else current = false;
    gate.release();
    await rejected;
    assert.equal(await readFile(fixture.filePath, "utf8"), fixture.original);
    assert.deepEqual(await readdir(fixture.directory), ["session.json"]);
  });
}

test("Service save passes its original generation through the repo encryption await", async () => {
  const gate = latch();
  let written = false;
  const sandbox = vm.createContext({
    actionGeneration: 7,
    disposed: false,
    seenRevision: "",
    notify() {},
    repo: {
      write: async (_session, canCommit) => {
        await gate.promise;
        if (!canCommit()) throw new Error("session_changed");
        written = true;
        return { revision: "new" };
      },
    },
  });
  runSource(sourceFunction(serviceSource, "save"), sandbox);
  const result = sandbox.save({ credentials: "synthetic" }, 7);
  const rejected = assert.rejects(result, /session_changed/);
  sandbox.actionGeneration = 8;
  gate.release();
  await rejected;
  assert.equal(written, false);
});

test("Repo timeout cannot resume into a write when the OS promise eventually succeeds", async (t) => {
  const gate = latch();
  const fixture = await repoFixture(t, async () => {
    await gate.promise;
    return "LATE_SYNTHETIC_CIPHERTEXT";
  });
  const realSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  // 只压缩真实repo的120s deadline；不伪造其Promise.race、finally或文件写入流程。
  globalThis.setTimeout = (callback, timeoutMs, ...args) => {
    deadlines.push(timeoutMs);
    return realSetTimeout(
      callback,
      timeoutMs === BRAND_ACCOUNT_CIPHER_TIMEOUT_MS ? 10 : timeoutMs,
      ...args,
    );
  };
  try {
    await assert.rejects(
      fixture.repo.write(fixture.session),
      (error) => error.code === "storage_unavailable",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  gate.release();
  await flush();
  assert.deepEqual(deadlines, [BRAND_ACCOUNT_CIPHER_TIMEOUT_MS]);
  assert.equal(await readFile(fixture.filePath, "utf8"), fixture.original);
  assert.deepEqual(await readdir(fixture.directory), ["session.json"]);
});
