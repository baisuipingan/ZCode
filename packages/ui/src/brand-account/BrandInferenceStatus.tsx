import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useBrandAccount } from "./context.js";
import { BrandModelSyncStatus } from "./BrandModelSyncStatus.js";
import { brandErrorMessageId, brandInferenceRecoveryAction } from "./presentation.js";

export function BrandInferenceStatus({ detailed = false }: { detailed?: boolean }) {
  const { intl } = useZCodeIntl();
  const { snapshot, refreshAgentConfig, service } = useBrandAccount();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const [failedEpoch, setFailedEpoch] = useState<number | null>(null);
  const authenticated = snapshot?.status === "authenticated";
  const initializing = !snapshot || snapshot.status === "initializing";
  const status = authenticated
    ? snapshot.inference.status
    : initializing
      ? "connecting"
      : "signedOut";
  const refreshing = snapshot?.inference.refreshStatus === "refreshing";
  const error = authenticated
    ? (snapshot.inference.error ?? snapshot.inference.refreshError)
    : snapshot?.error;
  const action = authenticated ? brandInferenceRecoveryAction(error) : "reauthenticate";
  const canAct =
    status !== "connecting" && (detailed || status !== "configured") && action !== "none";
  const recover = async () => {
    setFailedEpoch(null);
    try {
      if (action === "reauthenticate") {
        if (authenticated) await service?.logout();
        // 允许本地浏览时 Root 不会自动切回全页登录，沿现有设置入口恢复授权。
        setPendingSettingsSectionIntent("account");
        openSettingsTab();
      } else await refreshAgentConfig({ force: true });
    } catch {
      // 旧账号动作迟到只记其epoch，不能给新账号展示失败。
      setFailedEpoch(snapshot?.accountEpoch ?? null);
    }
  };
  if (!detailed && status === "configured") return null;
  return (
    <div className="min-w-0 space-y-1" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-caption text-foreground-subtle">
        <span role="status" data-testid="brand-inference-status">
          {intl.formatMessage({
            id:
              snapshot?.status === "expired"
                ? "brandAccount.error.expired"
                : `brandAccount.inference.${status}`,
          })}
        </span>
        {canAct ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid={detailed ? "brand-model-refresh" : "brand-inference-reconnect"}
            disabled={refreshing}
            onClick={() => void recover()}
          >
            <RefreshCw
              className={`size-3 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
            {intl.formatMessage({
              id:
                action === "reauthenticate"
                  ? "brandAccount.reauthenticate"
                  : "brandAccount.models.refresh",
            })}
          </Button>
        ) : null}
      </div>
      {error && status === "unavailable" ? (
        <p
          role="alert"
          data-testid="brand-inference-error"
          className="text-ui-caption text-warning"
        >
          {intl.formatMessage({ id: brandErrorMessageId(error) })}
        </p>
      ) : null}
      {failedEpoch !== null && failedEpoch === snapshot?.accountEpoch ? (
        <p role="alert" className="text-ui-caption text-warning">
          {intl.formatMessage({ id: "brandAccount.error.generic" })}
        </p>
      ) : null}
      {detailed ? <BrandModelSyncStatus /> : null}
    </div>
  );
}
