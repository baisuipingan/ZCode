import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw, User, Wallet } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useBrandAccount } from "./context.js";
import { formatBrandBalance } from "./presentation.js";

export function BrandAccountSummary() {
  const { intl } = useZCodeIntl();
  const { snapshot, openRecharge } = useBrandAccount();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const user = snapshot?.user;
  const name =
    user?.username || user?.email || intl.formatMessage({ id: "brandAccount.login.title" });
  const open = () => {
    setPendingSettingsSectionIntent("account");
    openSettingsTab();
  };
  return (
    <div className="min-w-0 flex-1 space-y-1" data-testid="brand-account-summary">
      <Button
        variant="ghost"
        onClick={open}
        data-testid="brand-account-open"
        className="h-auto w-full justify-start px-1 py-1"
      >
        <Avatar size="default">
          <AvatarFallback>
            {user ? name.slice(0, 1).toUpperCase() : <User className="size-4" />}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 truncate text-ui-base font-medium" title={name}>
          {name}
        </span>
      </Button>
      {snapshot?.status === "authenticated" ? (
        <BrandBalanceDisplay
          compact
          actions={
            <Button
              size="sm"
              variant="ghost"
              data-testid="brand-account-recharge"
              className="shrink-0 px-1.5"
              onClick={() => openRecharge()}
            >
              <Wallet className="size-3.5" />
              {intl.formatMessage({ id: "brandAccount.recharge" })}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/** 侧栏与设置消费同一快照；刷新按钮与资料导航分开，避免嵌套按钮。 */
export function BrandBalanceDisplay({
  compact = false,
  actions,
}: {
  compact?: boolean;
  actions?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const { snapshot, refreshBalance, service } = useBrandAccount();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const [failedEpoch, setFailedEpoch] = useState<number | null>(null);
  const epoch = snapshot?.accountEpoch;
  const failed = failedEpoch !== null && failedEpoch === epoch;
  const wallet = snapshot?.wallet;
  useEffect(() => {
    if (wallet?.status === "fresh") setFailedEpoch(null);
  }, [wallet?.status, wallet?.fetchedAt]);
  const syncing = wallet?.status === "syncing";
  const stale = wallet?.status === "stale" || wallet?.status === "unavailable" || failed;
  const label = intl.formatMessage({
    id: syncing ? "brandAccount.syncing" : "brandAccount.refresh",
  });
  const statusMessage = syncing
    ? intl.formatMessage({ id: "brandAccount.syncing" })
    : stale
      ? intl.formatMessage({ id: "brandAccount.syncFailed" })
      : wallet?.fetchedAt
        ? intl.formatMessage(
            { id: "brandAccount.updatedAt" },
            {
              time: new Date(wallet.fetchedAt).toLocaleTimeString(locale, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
          )
        : intl.formatMessage({ id: "brandAccount.notSynced" });
  const requiresLogin = wallet?.error?.code === "reauthentication_required";
  const refresh = async () => {
    setFailedEpoch(null);
    try {
      await refreshBalance();
    } catch {
      // 换号后旧刷新失败只能关联原epoch，不得把新账号的余额标成失败。
      setFailedEpoch(epoch ?? null);
    }
  };
  const reauthenticate = async () => {
    setFailedEpoch(null);
    try {
      await service?.logout();
      // 允许本地浏览时 Root 不会自动返回登录；钱包恢复也须直接进入原账号设置。
      setPendingSettingsSectionIntent("account");
      openSettingsTab();
    } catch {
      setFailedEpoch(epoch ?? null);
    }
  };
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={compact ? "sr-only" : "text-ui-caption text-foreground-subtle"}>
            {intl.formatMessage({ id: "brandAccount.balance" })}
          </p>
          <span
            data-testid="brand-account-balance"
            title={statusMessage}
            className={compact ? "text-ui-base font-semibold" : "text-ui-xl font-semibold"}
          >
            {formatBrandBalance(snapshot, locale, wallet?.availableUsd ?? null)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            data-testid="brand-account-refresh"
            type="button"
            variant="ghost"
            size="icon-sm"
            title={label}
            aria-label={label}
            disabled={syncing}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={`size-3.5 ${syncing ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
          </Button>
          {actions}
        </div>
      </div>
      {/* 正常侧栏只保留两行；失败仍显式提示，不能让旧余额伪装成实时值。 */}
      {!compact || (stale && !requiresLogin) ? (
        <p
          data-testid={stale ? "brand-account-wallet-warning" : undefined}
          className={`text-ui-xs ${stale ? "text-warning" : "text-foreground-subtle"}`}
          role={stale ? "status" : undefined}
        >
          {statusMessage}
        </p>
      ) : null}
      {requiresLogin ? (
        <div className="space-y-1 text-ui-caption text-warning" role="alert">
          <p>{intl.formatMessage({ id: "brandAccount.error.reauth" })}</p>
          <Button size="sm" variant="outline" onClick={() => void reauthenticate()}>
            {intl.formatMessage({ id: "brandAccount.reauthenticate" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
