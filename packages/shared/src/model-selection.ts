import { z } from "zod";
import { completeModelConfigDataSchema } from "./model-config.js";

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** 可持久化的扣费归属；不包含 JWT、Key 或会轮换的凭据指纹。 */
export const managedBillingBindingSchema = z
  .object({
    origin: z.string().url(),
    accountRef: z.string().trim().min(1),
    accountEpoch: z.number().int().nonnegative(),
    policyRevision: z.string().trim().min(1),
  })
  .strict();
export type ManagedBillingBinding = z.infer<typeof managedBillingBindingSchema>;

export function sameManagedBillingBinding(
  left: ManagedBillingBinding | undefined,
  right: ManagedBillingBinding | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.origin === right.origin &&
    left.accountRef === right.accountRef &&
    left.accountEpoch === right.accountEpoch &&
    left.policyRevision === right.policyRevision,
  );
}

export const managedProviderAccessSchema = z
  .object({
    credentialRef: z.string().trim().min(1),
    billingBinding: managedBillingBindingSchema,
  })
  .strict();
export type ManagedProviderAccess = z.infer<typeof managedProviderAccessSchema>;

/** CLI→本机Host私有反馈；不写历史/Renderer，错误码只产生候选而不证明上游来源。 */
export const managedInferenceOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("turn_settled"), billingBinding: managedBillingBindingSchema })
    .strict(),
  z
    .object({
      kind: z.enum(["credential_rejected_candidate", "balance_rejected_candidate"]),
      managedAccess: managedProviderAccessSchema,
      credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type ManagedInferenceOutcome = z.infer<typeof managedInferenceOutcomeSchema>;

/** 执行配置的规范表示；仅用于新旧 Model 兼容性比较，不是凭据或安全散列。 */
export function managedModelConfigFingerprint(config: unknown): string {
  const parsed = completeModelConfigDataSchema.parse(config);
  // 原因：推荐默认档位仅决定新草稿的初始选择；既有 Model 已冻结其实际档位，不能因此失效。
  // 允许档位 values、请求映射 map 和能力约束仍完整参与比较。
  if (parsed.optionSpecs.reasoningLevel) delete parsed.optionSpecs.reasoningLevel.defaultLevel;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(parsed));
}

/** Host 唯一配置通道发布的完整非秘密策略；默认选择引用同一模型集合。 */
export const managedProviderPolicySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("blocked"), revision: z.string().trim().min(1) }).strict(),
  z
    .object({
      state: z.literal("ready"),
      revision: z.string().trim().min(1),
      billingBinding: managedBillingBindingSchema,
      providerId: z.string().trim().min(1),
      credentialRef: z.string().trim().min(1),
      baseUrl: z.string().url(),
      models: z
        .array(
          z
            .object({
              modelId: z.string().trim().min(1),
              displayName: z.string().trim().min(1).optional(),
              modelConfig: completeModelConfigDataSchema,
            })
            .strict(),
        )
        .max(32),
      defaultSelection: modelSelectionSchema.nullable(),
      unavailableModels: z
        .array(
          z
            .object({
              modelId: z.string().trim().min(1),
              displayName: z.string().trim().min(1),
              reasonCode: z.string().trim().min(1),
            })
            .strict(),
        )
        .max(32)
        .optional(),
    })
    .strict()
    .superRefine((policy, context) => {
      const defaultSelection = policy.defaultSelection;
      const selected = policy.models.find((model) => model.modelId === defaultSelection?.modelId);
      if (
        new Set(policy.models.map((model) => model.modelId)).size !== policy.models.length ||
        (defaultSelection !== null &&
          (defaultSelection.providerId !== policy.providerId ||
            !selected ||
            !defaultSelection.options?.reasoningLevel ||
            !selected.modelConfig.optionSpecs.reasoningLevel.values.includes(
              defaultSelection.options.reasoningLevel,
            )))
      ) {
        context.addIssue({
          code: "custom",
          message: "Managed default selection must match its model and public reasoning level",
        });
      }
    }),
]);
export type ManagedProviderPolicy = z.infer<typeof managedProviderPolicySchema>;

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}
