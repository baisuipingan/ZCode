import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBrandAccount } from "./context.js";
import { brandErrorMessageId } from "./presentation.js";

/** 同步时间与失败只读取 Host 快照；不保留 UI 自己的成功时钟。 */
export function BrandModelSyncStatus() {
  const { intl, locale } = useZCodeIntl();
  const { snapshot } = useBrandAccount();
  const inference = snapshot?.inference;
  const refreshing = inference?.refreshStatus === "refreshing";
  const failed = Boolean(inference?.refreshError);
  const failureReason = inference?.refreshError
    ? intl.formatMessage({ id: brandErrorMessageId(inference.refreshError) })
    : null;
  const lastSuccessfulAt = inference?.lastSuccessfulAt;
  const updatedAt = lastSuccessfulAt
    ? intl.formatMessage(
        { id: "brandAccount.models.updatedAt" },
        {
          time: new Date(lastSuccessfulAt).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      )
    : null;
  return (
    <div
      aria-live="polite"
      data-testid="brand-model-sync-status"
      data-last-successful-at={lastSuccessfulAt ?? ""}
      data-sync-state={
        refreshing ? "refreshing" : failed ? "failed" : lastSuccessfulAt ? "fresh" : "unknown"
      }
      className={`text-ui-xs ${failed && !refreshing ? "text-warning" : "text-foreground-subtle"}`}
    >
      <p role="status">
        {refreshing
          ? intl.formatMessage({ id: "brandAccount.models.refreshing" })
          : failed
            ? inference?.status !== "configured" && failureReason
              ? failureReason
              : intl.formatMessage({
                  id:
                    lastSuccessfulAt && inference?.status === "configured"
                      ? "brandAccount.models.syncFailed"
                      : "brandAccount.models.initialSyncFailed",
                })
            : lastSuccessfulAt
              ? updatedAt
              : intl.formatMessage({ id: "brandAccount.models.notSynced" })}
      </p>
      {failed && !refreshing && inference?.status === "configured" && failureReason ? (
        <p>{failureReason}</p>
      ) : null}
      {(refreshing || failed) && updatedAt ? (
        <p className="text-foreground-subtle">{updatedAt}</p>
      ) : null}
    </div>
  );
}
