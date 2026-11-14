import { z } from "zod";
import { createHash } from "node:crypto";
import {
  managedProviderPolicySchema,
  type ManagedBillingBinding,
  type ManagedProviderPolicy,
} from "@zcode/shared/model-selection";
import { BootstrapProtocolUnsupported, failure } from "./errors.js";
import type { BrandAccountErrorCode } from "./contract.js";

const boundedText = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reasoning = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modelSchema = z
  .object({
    id: boundedText,
    display_name: boundedText,
    context_window: positive,
    max_output_tokens: positive,
    default_max_output_tokens: positive,
    reasoning_levels: z.array(reasoning).min(1).max(7),
    default_reasoning: reasoning,
    supports_reasoning: z.boolean(),
    supports_streaming: z.boolean(),
    requires_mfjs_tool_schema: z.boolean(),
    input: z
      .object({
        text: z.boolean(),
        image: z.boolean(),
        video: z.boolean(),
        audio: z.boolean(),
        pdf: z.boolean(),
      })
      .strict(),
    output: z.object({ text: z.boolean() }).strict(),
    supports_tool_call: z.boolean(),
    supports_json_schema_output: z.boolean(),
    supports_native_web_search: z.boolean(),
    supports_mid_conversation_system: z.boolean(),
  })
  .strict();

const modelV4Schema = modelSchema.extend({
  max_output_tokens: positive.or(z.literal(0)),
  output_limit_kind: z.enum(["", "fixed", "unlimited", "not_published"]).optional(),
});

const bootstrapSchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    config_revision: boundedText,
    service_status: z.enum([
      "ready",
      "disabled",
      "not_configured",
      "forbidden",
      "credential_blocked",
    ]),
    reason_code: boundedText,
    provider: z
      .object({
        id: z.literal("milorouter-managed"),
        api_type: z.literal("openai-responses"),
        base_url: z.string().url().max(2048),
      })
      .strict()
      .optional(),
    models: z.array(modelSchema).max(32).optional(),
    unavailable_models: z
      .array(
        z
          .object({
            model_id: boundedText,
            display_name: boundedText,
            reason_code: z.enum(["model_unavailable", "reasoning_policy_changed"]),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    selection_policy: z
      .union([
        z
          .object({
            model_id: boundedText,
            reasoning_level: reasoning,
            max_output_tokens: positive,
            auxiliary: z.literal("inherit-main"),
          })
          .strict(),
        z
          .object({
            default: z
              .object({
                model_id: boundedText,
                reasoning_level: reasoning,
                max_output_tokens: positive,
              })
              .strict()
              .nullable(),
            auxiliary: z.literal("inherit-main"),
          })
          .strict(),
      ])
      .optional(),
    credential: z
      .object({
        id: z.string().regex(/^[1-9]\d{0,18}$/),
        key: z.string().min(1).max(4096),
        scope: boundedText,
        expires_at: z.string().datetime({ offset: true }).nullable(),
        authorization_scope: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const bootstrapV4Schema = bootstrapSchema.extend({
  schema_version: z.literal(4),
  models: z.array(modelV4Schema).max(32).optional(),
});
const supportedBootstrapSchema = z.union([bootstrapSchema, bootstrapV4Schema]);

export interface BrandInferenceIdentity {
  origin: string;
  accountRef: string;
  accountEpoch: number;
}

/** 服务端领取期间配置被替换；是有界重读信号，而非凭据已失效。 */
export class BootstrapConfigurationChanged extends Error {}

export async function requestInferenceBootstrap<T>(
  request: (protocolVersion: 3 | 4) => Promise<T>,
): Promise<T> {
  try {
    return await request(4);
  } catch (error) {
    if (!(error instanceof BootstrapProtocolUnsupported)) throw error;
    // 原因：旧服务尚不认识v4；只协商一次，回退请求仍由原账户owner校验epoch和凭据。
    return request(3);
  }
}

/** 后端只给能力和参数语义；CEL 映射由客户端固定构造，不执行远端表达式。 */
export function parseInferenceBootstrap(
  value: unknown,
  identity: BrandInferenceIdentity,
): {
  policy: Extract<ManagedProviderPolicy, { state: "ready" }>;
  key: string;
  keyId: string;
  expiresAt: number | null;
} {
  const parsed = supportedBootstrapSchema.safeParse(value);
  if (!parsed.success) throw failure("invalid_response");
  const data = parsed.data;
  if (data.service_status !== "ready") {
    if (
      data.provider ||
      data.models ||
      data.selection_policy ||
      data.credential ||
      data.unavailable_models
    )
      throw failure("invalid_response");
    if (data.reason_code === "configuration_changed") throw new BootstrapConfigurationChanged();
    // 原因：停用、到期和临时网络失败的恢复方式不同；仅白名单原因进入公开错误。
    const reasons: Record<string, BrandAccountErrorCode> = {
      disabled: "service_disabled",
      configuration_missing: "service_not_configured",
      user_forbidden: "account_forbidden",
      group_unavailable: "group_unavailable",
      group_forbidden: "group_forbidden",
      credential_disabled: "credential_disabled",
      credential_expired: "credential_expired",
      credential_quota_exhausted: "credential_quota_exhausted",
      configuration_invalid: "configuration_invalid",
      model_forbidden: "configuration_invalid",
    };
    throw failure(
      Object.hasOwn(reasons, data.reason_code)
        ? reasons[data.reason_code]!
        : "inference_unavailable",
    );
  }
  const { provider, selection_policy, credential } = data;
  const v3 = data.schema_version >= 3;
  if (
    v3
      ? !selection_policy ||
        !("default" in selection_policy) ||
        !credential?.authorization_scope ||
        !data.unavailable_models
      : !selection_policy ||
        "default" in selection_policy ||
        credential?.authorization_scope !== undefined ||
        data.unavailable_models !== undefined
  )
    throw failure("invalid_response");
  const selection =
    selection_policy && "default" in selection_policy ? selection_policy.default : selection_policy;
  const models = data.models;
  const model = models?.find((item) => item.id === selection?.model_id);
  if (
    !provider ||
    !credential ||
    !models ||
    (!v3 && (!selection || !model || models.length === 0)) ||
    (selection && !model)
  )
    throw failure("invalid_response");
  const endpoint = new URL(provider.base_url);
  if (
    endpoint.origin !== identity.origin ||
    endpoint.pathname.replace(/\/$/, "") !== "/v1" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw failure("invalid_response");
  if (
    (data.schema_version === 1 && models.length !== 1) ||
    new Set(models.map((item) => item.id)).size !== models.length ||
    (selection &&
      (selection.reasoning_level !== model?.default_reasoning ||
        selection.max_output_tokens !== model?.default_max_output_tokens)) ||
    (data.unavailable_models &&
      (new Set(data.unavailable_models.map((item) => item.model_id)).size !==
        data.unavailable_models.length ||
        data.unavailable_models.some((item) =>
          models.some((valid) => valid.id === item.model_id),
        ))) ||
    models.some(
      (item) =>
        !item.input.text ||
        !item.output.text ||
        !item.supports_tool_call ||
        !item.supports_streaming ||
        // 原因：v4区分官方物理上限与运营预算；未知/无独立上限的0不能作为请求预算。
        // 旧协议仍原样要求正数输出且严格小于上下文，不能借新字段放宽旧校验。
        (data.schema_version === 4
          ? item.default_max_output_tokens > item.context_window ||
            ("output_limit_kind" in item &&
            (item.output_limit_kind === "unlimited" || item.output_limit_kind === "not_published")
              ? item.max_output_tokens !== 0
              : item.max_output_tokens <= 0 ||
                item.default_max_output_tokens > item.max_output_tokens ||
                item.max_output_tokens > item.context_window)
          : item.default_max_output_tokens > item.max_output_tokens ||
            item.max_output_tokens >= item.context_window) ||
        !item.reasoning_levels.includes(item.default_reasoning) ||
        new Set(item.reasoning_levels).size !== item.reasoning_levels.length ||
        item.reasoning_levels.some(
          (level, index, levels) =>
            index > 0 &&
            reasoning.options.indexOf(level) <= reasoning.options.indexOf(levels[index - 1]!),
        ) ||
        (!item.supports_reasoning &&
          (item.reasoning_levels.length !== 1 || item.default_reasoning !== "none")),
    )
  )
    throw failure("invalid_response");
  const expiresAt = credential.expires_at === null ? null : Date.parse(credential.expires_at);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))
    throw failure("credential_expired");
  const billingBinding: ManagedBillingBinding = {
    ...identity,
    policyRevision: credential.authorization_scope ?? data.config_revision,
  };
  const policy = managedProviderPolicySchema.parse({
    state: "ready",
    revision: createHash("sha256")
      .update(
        JSON.stringify([
          data.config_revision,
          identity,
          credential.id,
          credential.authorization_scope,
          provider,
          models,
          selection_policy,
          data.unavailable_models,
        ]),
      )
      .digest("hex"),
    billingBinding,
    providerId: provider.id,
    credentialRef: `${credential.scope}:${credential.id}`,
    baseUrl: `${endpoint.origin}/v1`,
    defaultSelection:
      model && selection
        ? {
            providerId: provider.id,
            modelId: model.id,
            options: { reasoningLevel: selection.reasoning_level },
          }
        : null,
    models: models.map((model) => ({
      modelId: model.id,
      displayName: model.display_name,
      modelConfig: {
        enabled: true,
        properties: {
          requiresMfjsToolSchema: model.requires_mfjs_tool_schema,
          contextWindow: model.context_window,
          inputFormat: {
            supportsText: model.input.text,
            supportsImage: model.input.image,
            supportsVideo: model.input.video,
            supportsAudio: model.input.audio,
            supportsPdf: model.input.pdf,
          },
          outputFormat: { supportsText: model.output.text },
          supportsToolCall: model.supports_tool_call,
          supportsJsonSchemaOutput: model.supports_json_schema_output,
          supportsNativeWebSearch: model.supports_native_web_search,
          supportsMidConversationSystem: model.supports_mid_conversation_system,
        },
        optionSpecs: {
          reasoningLevel: {
            values: model.reasoning_levels,
            defaultLevel: model.default_reasoning,
            map: model.supports_reasoning
              ? 'reasoningLevel == "none" ? {} : {"reasoning": {"effort": reasoningLevel}}'
              : "{}",
          },
          maxOutputTokens: {
            // 此max是既有单次请求预算；不把未知官方上限投影为0或上下文减一。
            max: model.default_max_output_tokens,
            map: `{"max_output_tokens": maxOutputTokens > ${model.default_max_output_tokens} ? ${model.default_max_output_tokens} : maxOutputTokens}`,
          },
        },
      },
    })),
    unavailableModels:
      data.unavailable_models?.map((item) => ({
        modelId: item.model_id,
        displayName: item.display_name,
        reasonCode: item.reason_code,
      })) ?? [],
  });
  if (policy.state !== "ready") throw failure("invalid_response");
  return { policy, key: credential.key, keyId: credential.id, expiresAt };
}
