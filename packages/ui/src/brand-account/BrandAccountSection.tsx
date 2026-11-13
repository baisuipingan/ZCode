import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandOrder } from "./contract.js";
import { RefreshCw, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBrandAccount } from "./context.js";
import { BrandAccountLogin } from "./BrandAccountLogin.js";
import { BrandBalanceDisplay } from "./BrandAccountSummary.js";
import { BrandUsageHistory } from "./BrandUsageHistory.js";
import {
  brandErrorMessageId,
  brandOrderStatusId,
  formatBrandBalance,
  formatBrandMoney,
} from "./presentation.js";

export function BrandAccountSection() {
  const { intl, locale } = useZCodeIntl();
  const { snapshot, service, refreshBalance, openRecharge } = useBrandAccount();
  const [orders, setOrders] = useState<BrandOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const requestConfirmation = useConfirmDialog();
  const epoch = snapshot?.accountEpoch;
  const authenticated = snapshot?.status === "authenticated";
  const currentRef = useRef({ epoch, authenticated, service, active: true });
  currentRef.current = { epoch, authenticated, service, active: true };
  useEffect(() => {
    currentRef.current.active = true;
    return () => {
      currentRef.current.active = false;
    };
  }, []);
  const loadOrders = useCallback(async () => {
    if (!service || !authenticated) return;
    const isCurrent = () =>
      currentRef.current.active &&
      currentRef.current.service === service &&
      currentRef.current.epoch === epoch &&
      currentRef.current.authenticated;
    setOrdersLoading(true);
    setError(null);
    try {
      const page = await service.listOrders({ page: 1, pageSize: 20 });
      if (isCurrent()) setOrders(page.items);
    } catch (cause) {
      if (isCurrent()) setError(brandErrorMessageId(cause));
    } finally {
      if (isCurrent()) setOrdersLoading(false);
    }
  }, [authenticated, epoch, service]);
  useEffect(() => {
    if (!service || !authenticated) {
      setOrders([]);
      return;
    }
    let active = true;
    setOrders([]);
    setOrdersLoading(true);
    setError(null);
    void refreshBalance().catch(() => {});
    void service
      .listOrders({ page: 1, pageSize: 20 })
      .then((page) => {
        if (active) setOrders(page.items);
      })
      .catch((cause) => {
        if (active) setError(brandErrorMessageId(cause));
      })
      .finally(() => {
        if (active) setOrdersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authenticated, epoch, refreshBalance, service]);
  const logout = async () => {
    if (!service || loggingOut) return;
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "brandAccount.logoutTitle" }),
      description: intl.formatMessage({ id: "brandAccount.logoutDescription" }),
      confirmLabel: intl.formatMessage({ id: "brandAccount.logout" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (!confirmed) return;
    setLoggingOut(true);
    try {
      await service.logout();
    } catch (cause) {
      setError(brandErrorMessageId(cause));
    } finally {
      setLoggingOut(false);
    }
  };
  if (!authenticated) return <BrandAccountLogin variant="embedded" />;
  const userName = snapshot.user?.username || snapshot.user?.email || "";
  return (
    <div className="space-y-6" data-testid="brand-account-section">
      <section
        className="space-y-4 rounded-xl border border-border bg-card p-4"
        data-testid="brand-account-overview"
      >
        <div className="flex min-w-0 items-start gap-3">
          <Avatar size="lg">
            <AvatarFallback>{userName.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <h3 className="break-words text-ui-lg font-semibold">{userName}</h3>
            {snapshot.user?.email !== userName ? (
              <p className="break-all text-ui-base text-foreground-subtle">
                {snapshot.user?.email}
              </p>
            ) : null}
            <p className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage(
                { id: "brandAccount.userId" },
                { id: String(snapshot.user?.id ?? "") },
              )}
            </p>
          </div>
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <BrandBalanceDisplay
            actions={
              <Button size="sm" onClick={() => openRecharge()} data-testid="brand-account-recharge">
                {intl.formatMessage({ id: "brandAccount.recharge" })}
              </Button>
            }
          />
          {(snapshot.wallet.frozenUsd ?? 0) > 0 ? (
            <p className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage(
                { id: "brandAccount.frozen" },
                {
                  amount: formatBrandBalance(snapshot, locale, snapshot.wallet.frozenUsd),
                },
              )}
            </p>
          ) : null}
        </div>
      </section>
      {error ? (
        <p role="alert" className="text-ui-caption text-warning">
          {intl.formatMessage({ id: error })}
        </p>
      ) : null}
      <Tabs defaultValue="usage" className="min-w-0 gap-4">
        <TabsList
          variant="line"
          aria-label={intl.formatMessage({ id: "brandAccount.records.title" })}
          className="max-w-full"
        >
          <TabsTrigger value="usage" data-testid="brand-account-tab-usage">
            {intl.formatMessage({ id: "brandAccount.usage.recordsTitle" })}
          </TabsTrigger>
          <TabsTrigger value="orders" data-testid="brand-account-tab-orders">
            {intl.formatMessage({ id: "brandAccount.orders" })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="usage" className="min-w-0">
          <BrandUsageHistory showHeading={false} />
        </TabsContent>
        <TabsContent value="orders" className="min-w-0">
          <section className="space-y-3">
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadOrders()}
                disabled={ordersLoading}
              >
                <RefreshCw
                  className={`size-3.5 ${ordersLoading ? "animate-spin motion-reduce:animate-none" : ""}`}
                />
                {intl.formatMessage({ id: "brandAccount.refreshOrders" })}
              </Button>
            </div>
            {orders.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: ordersLoading ? "brandAccount.loading" : "brandAccount.noOrders",
                })}
              </p>
            ) : (
              <div className="divide-y divide-border rounded-xl border border-border">
                {orders.map((order) => (
                  <button
                    key={order.id}
                    data-testid={`brand-order-${order.id}`}
                    className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => openRecharge(order.id)}
                  >
                    <div className="min-w-0">
                      <p className="break-all text-ui-caption">{order.outTradeNo}</p>
                      <p className="text-ui-xs text-foreground-subtle">
                        {new Date(order.createdAt).toLocaleString(locale)}
                      </p>
                    </div>
                    <div className="text-right text-ui-caption">
                      <p>{formatBrandMoney(order.payAmount, order.paymentCurrency, locale)}</p>
                      <p className="text-foreground-subtle">
                        {intl.formatMessage(
                          { id: "brandAccount.orderCredit" },
                          {
                            amount: formatBrandMoney(order.creditedUsd, "USD", locale),
                          },
                        )}
                      </p>
                      <p>
                        {intl.formatMessage({
                          id: brandOrderStatusId(order.status),
                        })}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
      <Button
        variant="ghost"
        size="sm"
        className="text-foreground-subtle"
        data-testid="brand-account-logout"
        onClick={() => void logout()}
        disabled={loggingOut}
      >
        <LogOut className="size-4" />
        {intl.formatMessage({ id: "brandAccount.logout" })}
      </Button>
    </div>
  );
}
