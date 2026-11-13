import type { BrandUsageRecord } from "./contract.js";
import { failure } from "./errors.js";
import { record, text } from "./httpClient.js";

const unsigned = /^(0|[1-9]\d{0,18})$/;
const maxInt64 = 9_223_372_036_854_775_807n;

function credits(value: unknown): bigint | null {
  if (typeof value !== "string" || !unsigned.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= maxInt64 ? parsed : null;
}

function decimalUsd(
  numerator: bigint,
  denominator: bigint,
): {
  usdDecimal: string;
  precision: "exact" | "approximate" | "lessThan";
} {
  const scale = 1_000_000_000_000n;
  const quotient = (numerator * scale) / denominator;
  const remainder = (numerator * scale) % denominator;
  if (numerator > 0n && quotient === 0n) {
    return { usdDecimal: "0.000000000001", precision: "lessThan" };
  }
  const fraction = (quotient % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return {
    usdDecimal: `${quotient / scale}${fraction ? `.${fraction}` : ""}`,
    precision: remainder === 0n ? "exact" : "approximate",
  };
}

function charge(raw: Record<string, unknown>): BrandUsageRecord["charge"] {
  const charged = credits(raw.charge_credits_string);
  const perUsd = credits(raw.credits_per_usd_string);
  const actualCost =
    typeof raw.actual_cost === "number" && Number.isFinite(raw.actual_cost) && raw.actual_cost >= 0
      ? raw.actual_cost
      : null;
  if (
    charged !== null &&
    perUsd !== null &&
    perUsd > 0n &&
    !(charged === 0n && (actualCost ?? 0) > 0)
  ) {
    return {
      kind: "credits",
      credits: charged.toString(),
      creditsPerUsd: perUsd.toString(),
      ...decimalUsd(charged, perUsd),
    };
  }
  // 原因：旧引擎可能保留正actual_cost而credits为0；不能把缺账本快照的记录显示为免费。
  if (actualCost !== null) return { kind: "legacy", actualCostUsd: actualCost };
  return { kind: "unavailable" };
}

export function usageRecords(value: unknown): BrandUsageRecord[] {
  const page = record(value);
  if (!Array.isArray(page.items) || page.items.length > 20) throw failure("invalid_response");
  return page.items.map((value) => {
    const raw = record(value);
    const requestId = text(raw.request_id);
    const model = text(raw.model);
    const createdAt = text(raw.created_at);
    if (
      !requestId ||
      requestId.length > 512 ||
      !model ||
      model.length > 512 ||
      !Number.isFinite(Date.parse(createdAt))
    )
      throw failure("invalid_response");
    return { requestId, model, createdAt, charge: charge(raw) };
  });
}
