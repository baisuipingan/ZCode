import { createHash } from "node:crypto";
import {
  sameManagedBillingBinding,
  managedModelConfigFingerprint,
  type ManagedBillingBinding,
  type ManagedProviderAccess,
  type ManagedProviderPolicy,
  type ManagedInferenceOutcome,
} from "@zcode/shared/model-selection";
import type { BrandInferenceSnapshot } from "./contract.js";
import { AccountFailure, blocksInference, errorProjection, failure } from "./errors.js";
import {
  BootstrapConfigurationChanged,
  parseInferenceBootstrap,
  type BrandInferenceIdentity,
} from "./inferenceBootstrap.js";

/** 工厂返回给同进程组合根的私有端口；不注册 ServiceDescriptor/RPC。 */
export interface BrandManagedInferenceHost {
  getPolicy(): ManagedProviderPolicy;
  onDidChange(listener: (reason: string) => void): () => void;
  assertConfigured(): Promise<void>;
  ensureFreshForAdmission(): Promise<void>;
  assertAdmissionIdentity(access: ManagedProviderAccess): Promise<void>;
  readUsageScope(): Promise<{ keyId: string; policyRevision: string }>;
  reportOutcome(outcome: ManagedInferenceOutcome): Promise<void>;
  resolve(input: {
    providerId: string;
    modelId: string;
    managedAccess: ManagedProviderAccess;
    phase?: "admission" | "attempt";
    modelConfigRevision?: string;
  }): Promise<{ apiKey: string; apiKeyId: string; accountScope: string }>;
}

const FRESHNESS_MS = 60_000;
const REJECTION_REFRESH_COOLDOWN_MS = 5_000;
export function createManagedInference(options: {
  enabled: boolean;
  getAuthorizationGeneration: () => number;
  readIdentity: () => Promise<BrandInferenceIdentity>;
  bootstrap: () => Promise<{ data: unknown; identity: BrandInferenceIdentity }>;
  onSnapshot: (snapshot: BrandInferenceSnapshot) => void;
  onSettled?: (binding: ManagedBillingBinding) => void;
  canConnect?: () => boolean;
}) {
  let generation = 0;
  let disposed = false;
  let flight: Promise<void> | null = null;
  let policy: ManagedProviderPolicy = { state: "blocked", revision: "blocked:0" };
  let material: { key: string; keyId: string; expiresAt: number | null } | null = null;
  let snapshot: BrandInferenceSnapshot = {
    status: "signedOut",
    error: null,
    refreshStatus: "idle",
    lastSuccessfulAt: null,
    refreshError: null,
  };
  let failures = 0;
  let retryAt = 0;
  let lastRejectedFingerprint = "";
  let lastRejectedAt = 0;
  let rejectionFlight: Promise<void> | null = null;
  const listeners = new Set<(reason: string) => void>();
  function update(value: Partial<BrandInferenceSnapshot>) {
    snapshot = { ...snapshot, ...value };
    options.onSnapshot(snapshot);
  }
  function publish(reason: string) {
    for (const listener of listeners) listener(reason);
  }
  function invalidate(error?: unknown) {
    generation += 1;
    flight = null;
    material = null;
    policy = { state: "blocked", revision: `blocked:${generation}` };
    failures = 0;
    retryAt = 0;
    lastRejectedFingerprint = "";
    lastRejectedAt = 0;
    rejectionFlight = null;
    update({
      status: error ? "unavailable" : "signedOut",
      error: error ? errorProjection(error) : null,
      refreshStatus: "idle",
      lastSuccessfulAt: null,
      refreshError: null,
    });
    publish("managed-account-invalidated");
  }
  function assertAuthorizationGeneration(started: number) {
    // 同epoch登录刷新也可改变授权IO代次，异步身份读取完成后必须复核。
    if (started !== options.getAuthorizationGeneration()) throw failure("session_changed");
  }
  function fresh() {
    return (
      snapshot.lastSuccessfulAt !== null && Date.now() - snapshot.lastSuccessfulAt < FRESHNESS_MS
    );
  }
  async function readLatest(identity: BrandInferenceIdentity, started: number) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await options.bootstrap();
      const authorization = options.getAuthorizationGeneration();
      const current = await options.readIdentity();
      assertAuthorizationGeneration(authorization);
      if (
        disposed ||
        generation !== started ||
        !sameIdentity(identity, current) ||
        !sameIdentity(result.identity, current)
      )
        throw failure("session_changed");
      try {
        return parseInferenceBootstrap(result.data, current);
      } catch (error) {
        // 原因：正常保存可与领取Key竞争；同flight有界补取，不能把竞态当确证停用。
        if (!(error instanceof BootstrapConfigurationChanged)) throw error;
      }
    }
    throw failure("request_rejected");
  }
  async function refresh(input: { force?: boolean; admission?: boolean } = {}): Promise<void> {
    if (disposed || !options.enabled) throw failure("inference_unavailable");
    if (flight) return flight;
    if (!input.force && fresh()) return;
    if (!input.force && Date.now() < retryAt) {
      if (input.admission) throw failure(snapshot.refreshError?.code ?? "request_rejected");
      return;
    }
    const started = generation;
    const pending = (async () => {
      try {
        const identity = await options.readIdentity();
        if (disposed || generation !== started) throw failure("session_changed");
        update({
          status: policy.state === "ready" ? "configured" : "connecting",
          refreshStatus: "refreshing",
          refreshError: null,
        });
        const next = await readLatest(identity, started);
        const changed = JSON.stringify(policy) !== JSON.stringify(next.policy);
        material = { key: next.key, keyId: next.keyId, expiresAt: next.expiresAt };
        // 原因：同语义重新bootstrap不应更换策略对象或打断正在完成授权的请求。
        if (changed) policy = next.policy;
        failures = 0;
        retryAt = 0;
        update({
          status: "configured",
          error: null,
          refreshStatus: "idle",
          lastSuccessfulAt: Date.now(),
          refreshError: null,
        });
        if (changed) publish("managed-configured");
      } catch (error) {
        if (!disposed && generation === started) {
          const code = errorProjection(error).code;
          // 原因：控制面临时故障不能清空已验证目录；明确失效的身份/组/Key仍必须阻断。
          const blocked = blocksInference(code);
          if (blocked || policy.state !== "ready") {
            material = null;
            policy = { state: "blocked", revision: `blocked:${generation}:unavailable` };
            update({
              status: "unavailable",
              error: errorProjection(error),
              lastSuccessfulAt: null,
            });
            publish("managed-unavailable");
          }
          failures += 1;
          retryAt =
            Date.now() +
            Math.max(
              Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6)),
              error instanceof AccountFailure ? (error.retryAfterMs ?? 0) : 0,
            );
          update({ refreshStatus: "idle", refreshError: errorProjection(error) });
        }
        throw error;
      }
    })();
    flight = pending;
    try {
      await pending;
    } finally {
      if (flight === pending) flight = null;
    }
  }
  async function assertBinding(binding: ManagedBillingBinding): Promise<void> {
    const identity = await options.readIdentity();
    if (material && material.expiresAt !== null && material.expiresAt <= Date.now()) {
      invalidate(failure("credential_expired"));
    }
    if (
      disposed ||
      !sameIdentity(binding, identity) ||
      policy.state !== "ready" ||
      !sameManagedBillingBinding(binding, policy.billingBinding) ||
      !material
    )
      throw failure("inference_unavailable");
  }
  function validateModel(input: Parameters<BrandManagedInferenceHost["resolve"]>[0]) {
    if (
      policy.state !== "ready" ||
      input.providerId !== policy.providerId ||
      input.managedAccess.credentialRef !== policy.credentialRef
    )
      throw failure("inference_unavailable");
    const model = policy.models.find((item) => item.modelId === input.modelId);
    if (!model) throw failure("model_unavailable");
    if (
      input.phase !== "admission" &&
      input.modelConfigRevision !== managedModelConfigFingerprint(model.modelConfig)
    )
      throw failure("model_configuration_changed");
  }
  const host: BrandManagedInferenceHost = {
    getPolicy: () => structuredClone(policy),
    onDidChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportOutcome: async (outcome) => {
      const binding =
        outcome.kind === "turn_settled"
          ? outcome.billingBinding
          : outcome.managedAccess.billingBinding;
      const authorization = options.getAuthorizationGeneration();
      try {
        const identity = await options.readIdentity();
        assertAuthorizationGeneration(authorization);
        if (
          disposed ||
          !sameIdentity(binding, identity) ||
          policy.state !== "ready" ||
          !sameManagedBillingBinding(binding, policy.billingBinding)
        )
          return;
      } catch {
        return;
      }
      if (outcome.kind === "turn_settled") {
        options.onSettled?.(binding);
        return;
      }
      if (policy.state !== "ready" || !material) return;
      // 原因：同ID重置会换Key但不换授权scope；旧材料的迟到失败不能影响新材料。
      const fingerprint = createHash("sha256").update(material.key).digest("hex");
      if (
        outcome.managedAccess.credentialRef !== policy.credentialRef ||
        outcome.credentialFingerprint !== fingerprint
      )
        return;
      if (outcome.kind === "balance_rejected_candidate") {
        options.onSettled?.(binding);
        return;
      }
      if (rejectionFlight) return rejectionFlight;
      if (
        fingerprint === lastRejectedFingerprint &&
        Date.now() - lastRejectedAt < REJECTION_REFRESH_COOLDOWN_MS
      )
        return;
      lastRejectedFingerprint = fingerprint;
      lastRejectedAt = Date.now();
      const previous = flight;
      const started = generation;
      const pending = (async () => {
        // 候选可能晚于在途bootstrap的读取点；先等旧flight，再做事件后的新读取。
        if (previous) await previous.catch(() => {});
        if (
          disposed ||
          generation !== started ||
          policy.state !== "ready" ||
          !material ||
          !sameManagedBillingBinding(binding, policy.billingBinding) ||
          createHash("sha256").update(material.key).digest("hex") !== fingerprint
        )
          return;
        // 错误码不能证明是本机网关拒绝；仅bootstrap确定可用性，绝不重放付费请求或清登录。
        await refresh({ force: true });
      })();
      rejectionFlight = pending;
      try {
        await pending;
      } finally {
        if (rejectionFlight === pending) rejectionFlight = null;
      }
    },
    ensureFreshForAdmission: async () => {
      await refresh({ admission: true });
      await host.assertConfigured();
    },
    assertAdmissionIdentity: async (access) => {
      const authorization = options.getAuthorizationGeneration();
      await host.assertConfigured();
      assertAuthorizationGeneration(authorization);
      // 原因：新输入在freshness/CLI ACK后才冻结scope；此无Key握手只阻止跨账号迁移。
      if (policy.state !== "ready" || !sameIdentity(access.billingBinding, policy.billingBinding))
        throw failure("session_changed");
    },
    assertConfigured: async () => {
      if (policy.state !== "ready" && flight) await flight;
      if (policy.state !== "ready") throw failure("inference_unavailable");
      const authorization = options.getAuthorizationGeneration();
      await assertBinding(policy.billingBinding);
      assertAuthorizationGeneration(authorization);
    },
    readUsageScope: async () => {
      const captured = policy;
      if (captured.state !== "ready") throw failure("inference_unavailable");
      const authorization = options.getAuthorizationGeneration();
      await assertBinding(captured.billingBinding);
      assertAuthorizationGeneration(authorization);
      if (
        policy.state !== "ready" ||
        !sameManagedBillingBinding(captured.billingBinding, policy.billingBinding) ||
        !material
      )
        throw failure("session_changed");
      return { keyId: material.keyId, policyRevision: policy.billingBinding.policyRevision };
    },
    resolve: async (input) => {
      validateModel(input);
      const authorization = options.getAuthorizationGeneration();
      await assertBinding(input.managedAccess.billingBinding);
      assertAuthorizationGeneration(authorization);
      // 原因：目录可在身份IO期间更新，复核最新成员和参数而非旧对象引用，兼容更新继续执行。
      validateModel(input);
      if (policy.state !== "ready" || !material) throw failure("session_changed");
      return {
        apiKey: material.key,
        apiKeyId: material.keyId,
        accountScope: createHash("sha256")
          .update(JSON.stringify([policy.billingBinding.origin, policy.billingBinding.accountRef]))
          .digest("hex"),
      };
    },
  };
  return {
    host,
    prepare: () => {
      if (
        !options.enabled ||
        options.canConnect?.() === false ||
        snapshot.status === "configured" ||
        snapshot.status === "connecting"
      )
        return;
      void refresh({ force: true }).catch(() => {});
    },
    connect: () => refresh({ force: true }),
    refresh,
    invalidate,
    dispose: () => {
      disposed = true;
      invalidate();
      listeners.clear();
    },
  };
}
function sameIdentity(left: BrandInferenceIdentity, right: BrandInferenceIdentity): boolean {
  return (
    left.origin === right.origin &&
    left.accountRef === right.accountRef &&
    left.accountEpoch === right.accountEpoch
  );
}
