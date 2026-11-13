import { Emitter } from "@zcode/rpc";
import type { BrandAccountSnapshot, BrandLoginInput, IBrandAccountService } from "./contract.js";
import { errorProjection, failure, safeFailure } from "./errors.js";
import { createAccountHttpClient, number, record, text } from "./httpClient.js";
import {
  accountUser,
  privateSessionIdentity,
  agentRefreshForce,
  emptyWallet,
  publicSettings,
  validateLoginInput,
} from "./projections.js";
import { createSecretRepo, type PrivateSession } from "./secretRepo.js";
import { createManagedInference, type BrandManagedInferenceHost } from "./managedInference.js";
import { createBrandUsageReader } from "./usageReader.js";
import { createBrowserLogin, exchangeBrowserAuthorization } from "./browserLogin.js";
import { createAccountPaymentActions } from "./paymentActions.js";
import { initialAccountSnapshot } from "./initialSnapshot.js";
import { createSettlementRefresh } from "./settlementRefresh.js";

export interface CreateBrandAccountServiceOptions {
  baseUrl: string;
  filePath: string;
  fetch?: typeof globalThis.fetch;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  onInvalidate?: () => void;
  /** 只由Desktop本机组合根启用；旧账号钱包fixture不自动获得推理能力。 */
  managedInference?: { clientVersion: string; platform: "win32" | "darwin" };
}

export function createBrandAccountService(options: CreateBrandAccountServiceOptions): {
  service: IBrandAccountService;
  dispose: () => void;
  inference: BrandManagedInferenceHost;
} {
  const http = createAccountHttpClient(options.baseUrl, options.fetch ?? globalThis.fetch);
  const repo = createSecretRepo({ ...options, origin: http.origin });
  const changes = new Emitter<BrandAccountSnapshot>();
  let snapshot: BrandAccountSnapshot = initialAccountSnapshot();
  let disposed = false;
  let seenRevision = "";
  let actionGeneration = 0;
  let inferenceAuthBarrier: number | null = null;
  let inferenceIoGeneration = 0;
  let inferenceRefreshPending = false;
  let readGeneration = 0;
  let balanceFlight: Promise<BrandAccountSnapshot> | null = null;
  let followupFlight: Promise<BrandAccountSnapshot> | null = null;
  let initializeFlight: Promise<BrandAccountSnapshot> | null = null;
  let challenge: { token: string; epoch: number; expiresAt: number } | null = null;
  let browserAction: number | null = null;
  const completed = new Set<string>();
  const inference = createManagedInference({
    enabled: Boolean(options.managedInference),
    canConnect: () =>
      inferenceAuthBarrier === null &&
      !inferenceRefreshPending &&
      snapshot.status === "authenticated",
    getAuthorizationGeneration: () => inferenceIoGeneration,
    readIdentity: async () => {
      const started = inferenceIoGeneration;
      const session = await requireSession();
      // 原因：OS解密可能返回同epoch旧revision；本机刷新意图发生后旧读不得继续授权。
      if (started !== inferenceIoGeneration) throw failure("session_changed");
      return identity(session);
    },
    bootstrap: async () => {
      const session = await requireSession();
      const result = await authenticated(
        "/desktop/bootstrap",
        {
          client_version: options.managedInference!.clientVersion,
          protocol_version: 3,
          platform: options.managedInference!.platform,
        },
        session,
      );
      return { data: result.data, identity: identity(result.session) };
    },
    onSnapshot: (value) => {
      if (disposed) return;
      const wasConfigured = snapshot.inference.status === "configured";
      snapshot = { ...snapshot, inference: value };
      if (value.status !== "configured" && value.status !== "connecting") {
        usage.invalidate();
      }
      emit();
      if (value.status === "configured" && !wasConfigured) void usage.refresh();
    },
    onSettled: (binding) => settlement.enqueue(binding),
  });
  const settlement = createSettlementRefresh({
    currentBinding: () => {
      const policy = inference.host.getPolicy();
      return !disposed && snapshot.status === "authenticated" && policy.state === "ready"
        ? policy.billingBinding
        : null;
    },
    // 两个权威读独立执行；旧flight均须尾随事件后新读，不用本地估价推导余额。
    refresh: () => Promise.allSettled([balance(true), usage.refresh(true)]),
  });
  const usage = createBrandUsageReader({
    available: () =>
      !disposed &&
      Boolean(options.managedInference) &&
      snapshot.status === "authenticated" &&
      snapshot.inference.status === "configured",
    readScope: () => inference.host.readUsageScope(),
    read: async (keyId) =>
      (
        await authenticated(
          `/usage?api_key_id=${encodeURIComponent(keyId)}&page=1&page_size=20&sort_by=created_at&sort_order=desc`,
        )
      ).data,
    snapshot: () => snapshot.usage,
    publish: (value) => {
      if (!disposed) {
        snapshot = { ...snapshot, usage: value };
        emit();
      }
    },
  });
  const browserLogin = createBrowserLogin({
    origin: http.origin,
    begin: async () => {
      const action = ++actionGeneration;
      browserAction = action;
      inferenceAuthBarrier = action;
      inference.invalidate();
      const session = await repo.withLock(async () => {
        const before = await repo.read();
        if (disposed || action !== actionGeneration) throw failure("session_changed");
        const cleared = await save({
          ...before,
          epoch: before.epoch + 1,
          credentials: null,
          refreshUncertain: false,
        });
        if (disposed || action !== actionGeneration) throw failure("session_changed");
        adopt(cleared);
        snapshot = { ...snapshot, error: null };
        emit();
        return cleared;
      });
      return { action, session };
    },
    complete: async ({ action, session }, body) => {
      await repo.withLock(async () => {
        const latest = await repo.read();
        if (
          disposed ||
          action !== actionGeneration ||
          latest.epoch !== session.epoch ||
          latest.credentials
        )
          throw failure("session_changed");
        await exchangeBrowserAuthorization({
          body,
          request: http.request,
          assertCurrent: () => {
            if (disposed || action !== actionGeneration) throw failure("session_changed");
          },
          commit: async (data) => {
            await finishLogin(data, latest, action);
          },
        });
      });
      if (inferenceAuthBarrier === action) inferenceAuthBarrier = null;
      if (browserAction === action) browserAction = null;
      inference.prepare();
      await balance(true);
    },
    waiting: (expiresAt, error) => {
      if (disposed) return;
      snapshot = {
        ...snapshot,
        browserLogin: { status: expiresAt === null ? "idle" : "waiting", expiresAt },
        ...(error
          ? { error: errorProjection(failure(error)) }
          : expiresAt !== null
            ? { error: null }
            : {}),
      };
      if (expiresAt === null && browserAction !== null) {
        if (inferenceAuthBarrier === browserAction) inferenceAuthBarrier = null;
        browserAction = null;
        actionGeneration += 1;
      }
      emit();
    },
  });

  function identity(session: PrivateSession) {
    return privateSessionIdentity(
      session,
      http.origin,
      inferenceAuthBarrier !== null || inferenceRefreshPending,
    );
  }

  const copy = () => structuredClone(snapshot);
  function emit() {
    if (!disposed) changes.fire(copy());
  }
  function notify() {
    try {
      options.onInvalidate?.();
    } catch {
      /* 失效提示不影响已提交状态。 */
    }
  }

  function adopt(session: PrivateSession) {
    // 异步解密旧文件可能晚于新账号提交完成，epoch只能前进。
    if (session.epoch < snapshot.accountEpoch) return;
    if (
      session.refreshUncertain &&
      !inferenceRefreshPending &&
      inference.host.getPolicy().state === "ready"
    ) {
      inference.invalidate(failure("reauthentication_required"));
    }
    seenRevision = session.revision;
    const changedAccount = snapshot.accountEpoch !== session.epoch;
    if (changedAccount) {
      settlement.reset();
      balanceFlight = null;
      followupFlight = null;
      inference.invalidate();
      readGeneration += 1;
      challenge = null;
      completed.clear();
      snapshot = {
        ...snapshot,
        accountEpoch: session.epoch,
        user: null,
        wallet: emptyWallet(),
        challenge: null,
        error: null,
      };
    }
    if (session.credentials) {
      snapshot = { ...snapshot, status: "authenticated", challenge: null };
    } else if (snapshot.status !== "twoFactor" || changedAccount) {
      snapshot = {
        ...snapshot,
        status: "signedOut",
        user: null,
        wallet: emptyWallet(),
        challenge: null,
      };
    }
  }

  async function current(expected?: PrivateSession): Promise<PrivateSession> {
    if (disposed) throw failure("network");
    const session = await repo.read();
    if (session.epoch < snapshot.accountEpoch) throw failure("session_changed");
    if (
      expected &&
      (session.epoch !== expected.epoch ||
        session.credentials?.userId !== expected.credentials?.userId)
    ) {
      adopt(session);
      emit();
      throw failure("session_changed");
    }
    adopt(session);
    return session;
  }

  async function requireSession(expected?: PrivateSession): Promise<PrivateSession> {
    const session = await current(expected);
    if (!session.credentials) throw failure("unauthenticated");
    return session;
  }

  async function save(session: PrivateSession): Promise<PrivateSession> {
    const saved = await repo.write(session);
    seenRevision = saved.revision;
    notify();
    return saved;
  }

  async function expire(session: PrivateSession) {
    const saved = await save({
      ...session,
      epoch: session.epoch + 1,
      credentials: null,
      refreshUncertain: false,
    });
    adopt(saved);
    snapshot = {
      ...snapshot,
      status: "expired",
      error: errorProjection(failure("unauthenticated")),
    };
    emit();
  }

  async function refreshSession(expected: PrivateSession): Promise<PrivateSession> {
    return repo.withLock(async () => {
      const latest = await requireSession(expected);
      // 原因：另一Host可能已消费旧refresh；拿锁后必须重读，已换证则直接复用新pair。
      if (latest.credentials!.accessToken !== expected.credentials!.accessToken) return latest;
      if (!latest.credentials!.refreshToken) {
        await expire(latest);
        throw failure("unauthenticated");
      }
      if (latest.refreshUncertain) throw failure("reauthentication_required");
      let marked = latest;
      inferenceRefreshPending = true;
      inferenceIoGeneration += 1;
      try {
        marked = await save({ ...latest, refreshUncertain: true });
        const data = record(
          await http.request("/auth/refresh", {
            body: { refresh_token: marked.credentials!.refreshToken },
          }),
        );
        const access = text(data.access_token);
        const refresh = text(data.refresh_token);
        if (!access || !refresh) throw failure("invalid_response");
        const seconds = number(data.expires_in, 0);
        const saved = await save({
          ...marked,
          credentials: {
            ...marked.credentials!,
            accessToken: access,
            refreshToken: refresh,
            expiresAt: seconds > 0 ? Date.now() + seconds * 1000 : null,
          },
          refreshUncertain: false,
        });
        adopt(saved);
        return saved;
      } catch (error) {
        const safe = safeFailure(error);
        if (safe.code === "unauthenticated") {
          await expire(marked);
          throw safe;
        }
        if (safe.code === "rate_limited") {
          // 服务端auth限流中间件先于refresh handler，429没有消费token，可供用户稍后重试。
          await save({ ...marked, refreshUncertain: false });
          throw safe;
        }
        // 网络超时保留uncertain标记和原材料：不能假设服务器未消费token并自动重放。
        inference.invalidate(failure("reauthentication_required"));
        throw failure("reauthentication_required");
      } finally {
        inferenceRefreshPending = false;
        inferenceIoGeneration += 1;
      }
    });
  }

  async function authenticated(
    path: string,
    body?: unknown,
    expected?: PrivateSession,
  ): Promise<{ data: unknown; session: PrivateSession }> {
    let session = await requireSession(expected);
    if (
      session.credentials!.expiresAt !== null &&
      session.credentials!.expiresAt <= Date.now() + 5_000
    ) {
      session = await refreshSession(session);
    }
    let data: unknown;
    try {
      data = await http.request(path, {
        token: session.credentials!.accessToken,
        body,
      });
    } catch (error) {
      if (safeFailure(error).code !== "unauthenticated") throw safeFailure(error);
      session = await refreshSession(session);
      // 仅bootstrap合同保证按用途幂等领取；支付等变更POST不能自动重放。
      if (body !== undefined && path !== "/desktop/bootstrap") throw failure("request_rejected");
      data = await http.request(path, {
        token: session.credentials!.accessToken,
        body,
      });
    }
    await current(session);
    return { data, session };
  }

  async function loadSettings() {
    const settings = publicSettings(await http.request("/settings/public"), http.origin);
    if (!disposed) {
      snapshot = { ...snapshot, settings };
      emit();
    }
  }

  function balance(afterCompletion = false): Promise<BrandAccountSnapshot> {
    if (afterCompletion && balanceFlight) {
      // COMPLETED之后不能复用入账前已发出的me；废弃旧结果并排队一次新读取。
      if (!followupFlight) {
        const accountEpoch = snapshot.accountEpoch;
        readGeneration += 1;
        emit();
        const pending = balanceFlight
          .catch(() => copy())
          .then(() => {
            if (followupFlight === pending) followupFlight = null;
            if (disposed || accountEpoch !== snapshot.accountEpoch) return copy();
            return balance();
          });
        followupFlight = pending;
      }
      return followupFlight;
    }
    if (balanceFlight) return balanceFlight;
    const operation = (async () => {
      let expected: PrivateSession | undefined;
      let generation = 0;
      try {
        expected = await current();
        if (!expected.credentials) {
          emit();
          return copy();
        }
        generation = ++readGeneration;
        snapshot = {
          ...snapshot,
          error: null,
          wallet: { ...snapshot.wallet, status: "syncing", error: null },
        };
        emit();
        const result = await authenticated("/auth/me", undefined, expected);
        const raw = record(result.data);
        const user = accountUser(raw);
        if (user.id !== expected.credentials.userId) throw failure("invalid_response");
        const availableUsd = number(raw.balance);
        const frozenUsd = number(raw.frozen_balance);
        await current(expected);
        if (generation !== readGeneration || disposed) return copy();
        snapshot = {
          ...snapshot,
          user,
          status: "authenticated",
          error: null,
          wallet: {
            status: "fresh",
            availableUsd,
            frozenUsd,
            fetchedAt: new Date().toISOString(),
            error: null,
          },
        };
        emit();
        return copy();
      } catch (error) {
        if (
          expected &&
          snapshot.accountEpoch === expected.epoch &&
          generation === readGeneration &&
          !disposed
        ) {
          snapshot = {
            ...snapshot,
            wallet: {
              ...snapshot.wallet,
              status: snapshot.wallet.fetchedAt ? "stale" : "unavailable",
              error: errorProjection(error),
            },
          };
          emit();
        }
        throw safeFailure(error);
      }
    })();
    balanceFlight = operation;
    void operation
      .finally(() => {
        if (balanceFlight === operation) balanceFlight = null;
      })
      .catch(() => {});
    return operation;
  }

  async function finishLogin(
    dataValue: unknown,
    session: PrivateSession,
    action: number,
  ): Promise<PrivateSession | null> {
    const data = record(dataValue);
    if (data.requires_2fa === true) {
      const token = text(data.temp_token);
      if (!token) throw failure("invalid_response");
      if (action !== actionGeneration || disposed) throw failure("session_changed");
      challenge = {
        token,
        epoch: session.epoch,
        expiresAt: Date.now() + 5 * 60_000,
      };
      snapshot = {
        ...snapshot,
        status: "twoFactor",
        challenge: { emailMasked: text(data.user_email_masked) },
        error: null,
      };
      emit();
      return null;
    }
    const accessToken = text(data.access_token);
    if (!accessToken) throw failure("invalid_response");
    const user = accountUser(data.user);
    const seconds = number(data.expires_in, 0);
    const saved = await save({
      ...session,
      credentials: {
        accessToken,
        refreshToken: text(data.refresh_token) || undefined,
        userId: user.id,
        expiresAt: seconds > 0 ? Date.now() + seconds * 1000 : null,
      },
      refreshUncertain: false,
    });
    if (action !== actionGeneration || disposed) throw failure("session_changed");
    challenge = null;
    adopt(saved);
    snapshot = { ...snapshot, user, challenge: null, error: null };
    emit();
    return saved;
  }

  async function login(input: BrandLoginInput): Promise<BrandAccountSnapshot> {
    browserLogin.cancel();
    validateLoginInput(input);
    const action = ++actionGeneration;
    inferenceAuthBarrier = action;
    inference.invalidate();
    try {
      if (!snapshot.settings) await loadSettings();
      const settings = snapshot.settings!;
      if (
        settings.aliyunCaptchaEnabled ||
        (settings.turnstileEnabled && !input.turnstileToken) ||
        (settings.tencentCaptchaEnabled &&
          (!input.tencentCaptchaTicket || !input.tencentCaptchaRandstr))
      )
        throw failure("captcha_required");
      const loggedIn = await repo.withLock(async () => {
        const before = await repo.read();
        const cleared = await save({
          ...before,
          epoch: before.epoch + 1,
          credentials: null,
          refreshUncertain: false,
        });
        if (action !== actionGeneration) throw failure("session_changed");
        adopt(cleared);
        emit();
        const data = await http.request("/auth/login", {
          context: "login",
          body: {
            email: input.email.trim(),
            password: input.password,
            turnstile_token: input.turnstileToken,
            tencent_captcha_ticket: input.tencentCaptchaTicket,
            tencent_captcha_randstr: input.tencentCaptchaRandstr,
          },
        });
        return finishLogin(data, cleared, action);
      });
      if (loggedIn) {
        if (inferenceAuthBarrier === action) inferenceAuthBarrier = null;
        inference.prepare();
        await balance(true);
        return copy();
      }
      return copy();
    } catch (error) {
      if (action === actionGeneration) {
        snapshot = { ...snapshot, error: errorProjection(error) };
        emit();
      }
      throw safeFailure(error);
    } finally {
      if (inferenceAuthBarrier === action) inferenceAuthBarrier = null;
    }
  }

  async function completeTwoFactor(code: string): Promise<BrandAccountSnapshot> {
    const pending = challenge;
    if (!pending || pending.expiresAt <= Date.now() || !/^\d{6}$/.test(code))
      throw failure("invalid_two_factor");
    const action = ++actionGeneration;
    inferenceAuthBarrier = action;
    inference.invalidate();
    try {
      await repo.withLock(async () => {
        const session = await repo.read();
        if (session.epoch !== pending.epoch || session.credentials)
          throw failure("session_changed");
        const data = await http.request("/auth/login/2fa", {
          context: "twoFactor",
          body: { temp_token: pending.token, totp_code: code },
        });
        await finishLogin(data, session, action);
      });
      if (inferenceAuthBarrier === action) inferenceAuthBarrier = null;
      inference.prepare();
      await balance(true);
      return copy();
    } catch (error) {
      if (action === actionGeneration) {
        snapshot = { ...snapshot, error: errorProjection(error) };
        emit();
      }
      throw safeFailure(error);
    } finally {
      if (inferenceAuthBarrier === action) inferenceAuthBarrier = null;
    }
  }

  async function logout(): Promise<BrandAccountSnapshot> {
    browserLogin.cancel();
    const action = ++actionGeneration;
    // 原因：invalidate只阻断旧flight；等跨Host锁期间initialize/迟到余额仍会尝试新bootstrap。
    // 本机意图屏障必须覆盖readIdentity与所有prepare入口，不能让旧磁盘登录重新授权。
    inferenceAuthBarrier = action;
    // 原因：跨Host登录锁/OS加密可能等待；用户退出意图到达后先停止本机新推理授权。
    inference.invalidate();
    try {
      await repo.withLock(async () => {
        const session = await repo.read();
        const oldRefresh = session.credentials?.refreshToken;
        const cleared = await save({
          ...session,
          epoch: session.epoch + 1,
          credentials: null,
          refreshUncertain: false,
        });
        adopt(cleared);
        snapshot = { ...snapshot, status: "signedOut", error: null };
        emit();
        // 本地退出先提交；服务端撤销为有界best effort，不把网络失败当本地仍登录。
        if (oldRefresh)
          void http
            .request("/auth/logout", { body: { refresh_token: oldRefresh } })
            .catch(() => {});
      });
      return copy();
    } catch (error) {
      if (action === actionGeneration) {
        snapshot = { ...snapshot, error: errorProjection(error) };
        emit();
      }
      throw safeFailure(error);
    } finally {
      // 原因：退出锁或加密失败不能永久遗留本机意图屏障，重试仍以磁盘账户权威为准。
      if (inferenceAuthBarrier === action) inferenceAuthBarrier = null;
    }
  }

  async function initialize(): Promise<BrandAccountSnapshot> {
    if (initializeFlight) return initializeFlight;
    const operation = (async () => {
      try {
        // 公共展示配置失败不能阻挡已保存会话的独立推理初始化。
        const settings = loadSettings();
        const session = current().then(() => {
          inference.prepare();
        });
        await Promise.all([settings, session]);
        emit();
        inference.prepare();
        await balance();
        await usage.refresh();
        return copy();
      } catch (error) {
        snapshot = {
          ...snapshot,
          status: snapshot.status === "initializing" ? "signedOut" : snapshot.status,
          error: errorProjection(error),
        };
        emit();
        throw safeFailure(error);
      }
    })();
    initializeFlight = operation;
    void operation
      .finally(() => {
        if (initializeFlight === operation) initializeFlight = null;
      })
      .catch(() => {});
    return operation;
  }

  const payment = createAccountPaymentActions({
    requireSession,
    loadSettings,
    authenticated,
    current,
    completed,
    onSettled: () => balance(true),
  });

  const stopWatching = repo.watch(() => {
    void repo
      .read()
      .then(async (session) => {
        if (disposed || session.revision === seenRevision) return;
        const changed = session.epoch !== snapshot.accountEpoch;
        adopt(session);
        emit();
        // 登录先写epoch墓碑再提交同epoch凭据；其他窗口可能已看过墓碑，不能只按epoch变化决定加载。
        if (
          session.credentials &&
          (changed ||
            snapshot.user?.id !== session.credentials.userId ||
            snapshot.wallet.status === "unknown" ||
            snapshot.inference.status !== "configured")
        ) {
          inference.prepare();
          await balance(true).catch(() => {});
        }
      })
      .catch(() => {
        if (!disposed) {
          inference.invalidate();
          snapshot = {
            ...snapshot,
            error: errorProjection(failure("storage_unavailable")),
          };
          emit();
        }
      });
  });

  // 运行时白名单对象：禁止将repo/cipher/HTTP/私有类方法挂到通用RPC。
  const service: IBrandAccountService = {
    getSnapshot: async () => copy(),
    initialize,
    refreshBalance: async () => {
      await balance();
      await usage.refresh();
      return copy();
    },
    refreshAgentConfig: async (input) => {
      await inference.refresh({ force: agentRefreshForce(input) });
      return copy();
    },
    startBrowserLogin: () => browserLogin.start(),
    cancelBrowserLogin: async () => {
      const active = browserAction !== null || snapshot.browserLogin.status === "waiting";
      const epoch = snapshot.accountEpoch;
      browserLogin.cancel();
      if (!active) return copy();
      // 原因：取消可能发生在加密保存期间；锁后墓碑保证晚到换证不能重新登录。
      await repo.withLock(async () => {
        const session = await repo.read();
        if (session.epoch !== epoch) {
          adopt(session);
          emit();
          return;
        }
        const cleared = await save({
          ...session,
          epoch: session.epoch + 1,
          credentials: null,
          refreshUncertain: false,
        });
        adopt(cleared);
        emit();
      });
      return copy();
    },
    login,
    completeTwoFactor,
    logout,
    ...payment,
    onDidChange: changes.event,
  };
  return {
    service,
    inference: inference.host,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      browserLogin.dispose();
      settlement.reset();
      inference.dispose();
      challenge = null;
      actionGeneration += 1;
      readGeneration += 1;
      stopWatching();
      repo.dispose();
      http.dispose();
      changes.dispose();
    },
  };
}
