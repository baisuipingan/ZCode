import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { BrandUsageRecord } from "./contract.js";
import { useBrandAccount } from "./context.js";
import { formatBrandMoney } from "./presentation.js";

function UsageAmount({ charge, locale }: { charge: BrandUsageRecord["charge"]; locale: string }) {
  const { intl } = useZCodeIntl();
  if (charge.kind === "unavailable")
    return intl.formatMessage({ id: "brandAccount.usage.pendingAmount" });
  if (charge.kind === "legacy") return formatBrandMoney(charge.actualCostUsd, "USD", locale);
  const prefix =
    charge.precision === "approximate" ? "≈ " : charge.precision === "lessThan" ? "< " : "";
  // 原因：消费可能超过JS安全整数范围；Host已生成精确十进制，不得再经Number格式化。
  return `${prefix}USD $${charge.usdDecimal}`;
}

/** Host是消费记录唯一owner；本组件只展示快照，刷新复用既有余额同步。 */
export function BrandUsageHistory({ showHeading = true }: { showHeading?: boolean }) {
  const { intl, locale } = useZCodeIntl();
  const { snapshot, refreshBalance } = useBrandAccount();
  const usage = snapshot?.usage;
  const syncing = usage?.status === "syncing";
  const stale = usage?.status === "stale" || usage?.status === "unavailable";
  const hasItems = Boolean(usage?.items.length);
  const title = intl.formatMessage({ id: "brandAccount.usage.title" });
  return (
    <section className="space-y-3" aria-label={title} data-testid="brand-usage-section">
      <div
        className={`flex flex-wrap items-center gap-3 ${showHeading ? "justify-between" : "justify-end"}`}
      >
        {showHeading ? <h3 className="text-ui-lg font-medium">{title}</h3> : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={syncing || snapshot?.wallet.status === "syncing"}
          data-testid="brand-usage-refresh"
          onClick={() => void refreshBalance().catch(() => {})}
        >
          <RefreshCw
            className={`size-3.5 ${syncing ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
          {intl.formatMessage({ id: "brandAccount.usage.refresh" })}
        </Button>
      </div>
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "brandAccount.usage.scope" })}
      </p>
      <p
        className={`text-ui-caption ${stale ? "text-warning" : "text-foreground-subtle"}`}
        aria-live="polite"
        data-testid="brand-usage-status"
      >
        {syncing
          ? intl.formatMessage({ id: "brandAccount.syncing" })
          : stale
            ? intl.formatMessage({
                id: hasItems ? "brandAccount.usage.stale" : "brandAccount.usage.unavailable",
              })
            : usage?.fetchedAt
              ? intl.formatMessage(
                  { id: "brandAccount.updatedAt" },
                  { time: new Date(usage.fetchedAt).toLocaleString(locale) },
                )
              : intl.formatMessage({ id: "brandAccount.notSynced" })}
      </p>
      {hasItems ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {usage?.items.map((record) => (
            <li
              key={record.requestId}
              data-testid="brand-usage-row"
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <p className="break-all text-ui-base">{record.model}</p>
                <p className="text-ui-xs text-foreground-subtle">
                  {new Date(record.createdAt).toLocaleString(locale)}
                </p>
              </div>
              <p
                className="max-w-full break-all text-right text-ui-caption tabular-nums"
                data-testid="brand-usage-amount"
              >
                <UsageAmount charge={record.charge} locale={locale} />
              </p>
            </li>
          ))}
        </ul>
      ) : usage?.status === "fresh" ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "brandAccount.usage.empty" })}
        </p>
      ) : null}
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "brandAccount.usage.delayNotice" })}
      </p>
    </section>
  );
}
