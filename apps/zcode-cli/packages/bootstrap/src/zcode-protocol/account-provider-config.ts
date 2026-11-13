import {
  zcodeProviderRefreshRegistryParamsSchema,
  zcodeProviderUpdateAccountConfigParamsSchema,
  type ZCodeProviderRefreshRegistryResult,
  type ZCodeProviderUpdateAccountConfigResult,
} from "@zcode/shared";
import { validateModelSelectionOptions } from "@zcode/provider";
import { closeSessionRuntime } from "./session-residency.js";
import { parseProcessAccountProviderConfigSnapshot } from "../app/process-provider-registry-runtime.js";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * 更新进程级 Account Provider Config。
 *
 * 该协议传 Account Overlay 与对应状态；API Key、JWT 和动态 Header 由请求期鉴权协议处理。
 */
export async function updateAccountProviderConfig(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderUpdateAccountConfigResult> {
  const envelope = parseParams(zcodeProviderUpdateAccountConfigParamsSchema, params);
  const snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
  if (!context.deps.syncAccountProviderConfig) {
    throw new ProtocolRequestError(-32018, "Account Provider Config runtime is not configured");
  }
  const previousPolicy = context.deps.readProviderRegistrySnapshot?.()?.account.managedPolicy;
  if (
    previousPolicy?.state === "ready" &&
    snapshot.managedPolicy &&
    (snapshot.managedPolicy.state !== "ready" ||
      previousPolicy.billingBinding.origin !== snapshot.managedPolicy.billingBinding.origin ||
      previousPolicy.billingBinding.accountRef !==
        snapshot.managedPolicy.billingBinding.accountRef ||
      previousPolicy.billingBinding.accountEpoch !==
        snapshot.managedPolicy.billingBinding.accountEpoch)
  ) {
    // 原因：同账号配置变化不是撤销正在执行的本地工具或已打开的流；仅换号/退出或确证失效时取消。
    // 目录、分组、路由和凭据变化留给下一 attempt 的原授权作用域/凭据与执行指纹检查。
    // 只释放 resident runtime，持久输入/队列不改写；后续冷恢复由原 binding guard 决定可否执行。
    const records = [...context.sessions.entries()];
    for (const [, record] of records) {
      record.app.runtime.beginShutdown();
      record.app.runtime.stopActiveForegroundExecution?.({ reason: "managed policy changed" });
      record.activeAbortController?.abort(new Error("Managed policy changed"));
    }
    const closed = await Promise.allSettled(
      records.map(([sessionId]) => closeSessionRuntime(context, sessionId)),
    );
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Managed policy runtime cancellation failed");
  }
  const changed = await context.deps.syncAccountProviderConfig(snapshot);
  const applied = context.deps.readProviderRegistrySnapshot?.();
  const matched = applied?.sourceRevisions.account === snapshot.revision;
  const policy = matched ? applied.account.managedPolicy : undefined;
  const managedProvider =
    policy?.state === "ready"
      ? applied!.registry.providers.find((provider) => provider.providerId === policy.providerId)
      : undefined;
  const managedModel =
    policy?.state === "ready" && policy.defaultSelection
      ? managedProvider?.models.find((model) => model.modelId === policy.defaultSelection!.modelId)
      : undefined;
  const managedReady =
    policy?.state === "ready" &&
    // 原因：多模型策略必须整份实际应用，不能仅默认项存在就放行其余模型。
    (policy.models.length === 0 ||
      (managedProvider !== undefined &&
        managedProvider.models.length === policy.models.length &&
        policy.models.every((model) =>
          managedProvider.models.some((appliedModel) => appliedModel.modelId === model.modelId),
        ))) &&
    (policy.defaultSelection === null ||
      (managedModel !== undefined &&
        validateModelSelectionOptions(managedModel, policy.defaultSelection).ok));
  return {
    receivedRevision: snapshot.revision,
    providerCount: snapshot.providers.keys().length,
    status: changed ? "received" : "unchanged",
    ...(matched ? { appliedRevision: snapshot.revision } : {}),
    ...(snapshot.managedPolicy ? { managedReady: Boolean(managedReady) } : {}),
  };
}

/**
 * 让当前 Worker 重新读取自己的 Personal/Account Config Store。
 *
 * 该请求只触发 Worker 本地刷新，不接收 Desktop Registry 快照，避免把远端 Environment
 * 的 Provider 权威重新下沉到 Host。执行入口在 ACK 前调用它，封住 Provisioning 后存量
 * Worker 仍持有旧 Registry 的窗口。
 */
export async function refreshProviderRegistry(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderRefreshRegistryResult> {
  const envelope = zcodeProviderRefreshRegistryParamsSchema.parse(params);
  if (!context.deps.refreshProviderRegistry) {
    throw new ProtocolRequestError(-32019, "Provider Registry refresh is not configured");
  }
  await context.deps.refreshProviderRegistry(envelope.reason);
  return { refreshed: true };
}
