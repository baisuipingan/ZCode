import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandCheckout, BrandCreateOrderResult, BrandOrder } from "./contract.js";
import QRCode from "qrcode";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBrandAccount } from "./context.js";
import {
  brandErrorMessageId,
  brandOrderStatusId,
  brandWebsiteUrl,
  formatBrandMoney,
  isPendingBrandOrder,
} from "./presentation.js";

export function BrandRechargeDialog({
  initialOrderId,
  onClose,
}: {
  initialOrderId?: number;
  onClose(): void;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { snapshot, service, refreshBalance } = useBrandAccount();
  const [checkout, setCheckout] = useState<BrandCheckout | null>(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<BrandOrder[]>([]);
  const [order, setOrder] = useState<BrandOrder | null>(null);
  const [payment, setPayment] = useState<BrandCreateOrderResult | null>(null);
  const [method, setMethod] = useState("");
  const [amount, setAmount] = useState("");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const activeRef = useRef(true);
  const creatingRef = useRef(false);
  const checkingRef = useRef(false);
  const viewGeneration = useRef(0);
  const [selecting, setSelecting] = useState(false);
  const text = (id: string) => intl.formatMessage({ id: `brandAccount.${id}` });

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const acceptOrder = useCallback((next: BrandOrder) => {
    if (!activeRef.current) return;
    setOrder(next);
    // 入账后的强制余额刷新由 Host 服务负责；UI 只投影订单事实，避免多写入路径。
  }, []);
  useEffect(() => {
    if (!service) return;
    let active = true;
    setLoading(true);
    setError(null);
    void refreshBalance().catch(() => {});
    void Promise.all([service.getCheckout(), service.listOrders({ page: 1, pageSize: 20 })])
      .then(([config, page]) => {
        if (!active) return;
        setCheckout(config);
        setOrders(page.items);
        setMethod((current) =>
          config.methods.some((item) => item.paymentType === current)
            ? current
            : (config.methods[0]?.paymentType ?? ""),
        );
      })
      .catch((cause) => {
        if (active) setError(brandErrorMessageId(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshBalance, refreshVersion, service]);
  useEffect(() => {
    if (!service || initialOrderId === undefined) return;
    let active = true;
    const generation = ++viewGeneration.current;
    const isCurrent = () => active && activeRef.current && generation === viewGeneration.current;
    setSelecting(true);
    void service
      .getOrder(initialOrderId)
      .then((next) => {
        if (isCurrent()) acceptOrder(next);
      })
      .catch((cause) => {
        if (isCurrent()) setError(brandErrorMessageId(cause));
      })
      .finally(() => {
        if (isCurrent()) setSelecting(false);
      });
    return () => {
      active = false;
    };
  }, [acceptOrder, initialOrderId, service]);
  useEffect(() => {
    if (!service || !order || !isPendingBrandOrder(order.status)) return;
    let active = true;
    let failures = 0;
    let timer: number | undefined;
    const generation = viewGeneration.current;
    const isCurrent = () => active && activeRef.current && generation === viewGeneration.current;
    const schedule = (delay: number) => {
      timer = window.setTimeout(check, delay);
    };
    const check = () => {
      if (!isCurrent()) return;
      if (checkingRef.current) {
        schedule(4000);
        return;
      }
      checkingRef.current = true;
      void service
        .getOrder(order.id)
        .then((next) => {
          if (!isCurrent()) return;
          failures = 0;
          setError(null);
          acceptOrder(next);
        })
        .catch((cause) => {
          if (!isCurrent()) return;
          setError(brandErrorMessageId(cause));
          // 暂时断网按有界退避继续只读查询；三次失败后保留订单，用户可显式核验。
          failures += 1;
          if (failures < 3) schedule(Math.min(4000 * 2 ** failures, 30000));
        })
        .finally(() => {
          checkingRef.current = false;
        });
    };
    schedule(4000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [acceptOrder, order, service]);
  // 支付动作必须与当前订单绑定；切换列表时绝不能展示另一订单的二维码或链接。
  const currentPayment = payment?.order?.id === order?.id ? payment : null;
  const qrCode = currentPayment?.kind === "payment" ? currentPayment.qrCode : null;
  useEffect(() => {
    let active = true;
    setQr(null);
    setQrFailed(false);
    if (qrCode) {
      void QRCode.toDataURL(qrCode, {
        width: 256,
        margin: 2,
        errorCorrectionLevel: "M",
      })
        .then((url) => {
          if (active) setQr(url);
        })
        .catch(() => {
          if (active) setQrFailed(true);
        });
    }
    return () => {
      active = false;
    };
  }, [qrCode]);

  const selectedMethod = checkout?.methods.find((item) => item.paymentType === method);
  const min = Math.max(checkout?.minAmount ?? 0, selectedMethod?.singleMin ?? 0);
  const positiveMax = [checkout?.maxAmount, selectedMethod?.singleMax].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  const max = positiveMax.length ? Math.min(...positiveMax) : null;
  const numericAmount = Number(amount);
  const validAmount =
    amount.trim() !== "" &&
    Number.isFinite(numericAmount) &&
    numericAmount > 0 &&
    numericAmount >= min &&
    (max === null || numericAmount <= max);
  const canCreate =
    checkout?.enabled &&
    !checkout.balanceDisabled &&
    Boolean(selectedMethod) &&
    validAmount &&
    !creating &&
    !selecting &&
    !uncertain &&
    payment?.kind !== "unsupported";
  const payUrl = currentPayment?.kind === "payment" ? safePaymentUrl(currentPayment.payUrl) : null;
  const website = brandWebsiteUrl(snapshot?.settings?.siteUrl, "/orders");
  const create = async () => {
    if (!service || !canCreate || creatingRef.current || selecting) return;
    const generation = ++viewGeneration.current;
    const isCurrent = () => activeRef.current && generation === viewGeneration.current;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const result = await service.createOrder({
        amount: numericAmount,
        paymentType: method,
      });
      if (!isCurrent()) return;
      setPayment(result);
      if (result.order) acceptOrder(result.order);
    } catch (cause) {
      if (isCurrent()) {
        setError(brandErrorMessageId(cause));
        // POST 响应未知时不能自动重试建单；先到本人列表确认，避免重复扣款/重复订单。
        setUncertain(true);
      }
    } finally {
      creatingRef.current = false;
      if (isCurrent()) setCreating(false);
    }
  };
  const verify = async () => {
    if (!service || !order || checkingRef.current) return;
    const generation = viewGeneration.current;
    const isCurrent = () => activeRef.current && generation === viewGeneration.current;
    checkingRef.current = true;
    setChecking(true);
    setError(null);
    try {
      const next = await service.verifyOrder(order.outTradeNo);
      if (isCurrent()) acceptOrder(next);
    } catch (cause) {
      if (isCurrent()) setError(brandErrorMessageId(cause));
    } finally {
      checkingRef.current = false;
      if (isCurrent()) setChecking(false);
    }
  };
  const showOrder = async (id: number) => {
    if (!service || creatingRef.current) return;
    const generation = ++viewGeneration.current;
    const isCurrent = () => activeRef.current && generation === viewGeneration.current;
    setSelecting(true);
    setOrder(null);
    setPayment(null);
    setQr(null);
    setError(null);
    try {
      const next = await service.getOrder(id);
      if (isCurrent()) acceptOrder(next);
    } catch (cause) {
      if (isCurrent()) setError(brandErrorMessageId(cause));
    } finally {
      if (isCurrent()) setSelecting(false);
    }
  };
  const status = order?.status.toUpperCase();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-xl"
        showCloseButton={false}
        data-testid="brand-recharge-dialog"
      >
        <DialogHeader>
          <DialogTitle>{text("rechargeTitle")}</DialogTitle>
          <DialogDescription>{text("rechargeDescription")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="flex items-center gap-2 text-ui-base" role="status">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            {text("loading")}
          </p>
        ) : null}
        {error ? (
          <div
            className="space-y-2 rounded-lg bg-warning-surface p-3 text-ui-caption text-warning-surface-foreground"
            role="alert"
          >
            <p>{intl.formatMessage({ id: error })}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (order) void verify();
                else setRefreshVersion((value) => value + 1);
              }}
            >
              {text("retry")}
            </Button>
          </div>
        ) : null}
        {payment?.kind === "unsupported" && !order ? (
          <div
            className="space-y-2 rounded-lg bg-warning-surface p-3 text-ui-caption text-warning-surface-foreground"
            role="status"
          >
            <p>{text("unsupportedPayment")}</p>
            {website ? (
              <Button variant="outline" onClick={() => void platform.openExternal(website)}>
                <ExternalLink className="size-4" />
                {text("websitePayment")}
              </Button>
            ) : null}
            <p>{text("websiteOrderNotice")}</p>
          </div>
        ) : null}
        {order ? (
          <div className="space-y-4" data-testid={`brand-order-${order.id}`}>
            <div className="space-y-2 rounded-xl border border-border bg-card p-4">
              <p className="text-ui-lg font-semibold" data-testid="brand-order-status">
                {intl.formatMessage({ id: brandOrderStatusId(order.status) })}
              </p>
              <dl className="space-y-2 text-ui-base">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt>{text("orderNumber")}</dt>
                  <dd className="break-all text-ui-caption">{order.outTradeNo}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>{text("paidAmount")}</dt>
                  <dd>{formatBrandMoney(order.payAmount, order.paymentCurrency, locale)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>{text("creditedAmount")}</dt>
                  <dd>{formatBrandMoney(order.creditedUsd, "USD", locale)}</dd>
                </div>
                {order.bonusUsd > 0 ? (
                  <div className="flex justify-between gap-2">
                    <dt>{text("includedBonus")}</dt>
                    <dd>{formatBrandMoney(order.bonusUsd, "USD", locale)}</dd>
                  </div>
                ) : null}
                {order.expiresAt ? (
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt>{text("expiresAt")}</dt>
                    <dd>{new Date(order.expiresAt).toLocaleString(locale)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
            {status === "COMPLETED" ? (
              <p className="text-ui-base text-success" role="status">
                {text(
                  snapshot?.wallet.status === "fresh" ? "completedNotice" : "completedSyncPending",
                )}
              </p>
            ) : null}
            {status === "PAID" || status === "RECHARGING" ? (
              <p className="text-ui-base" role="status">
                {text("creditingNotice")}
              </p>
            ) : null}
            {status === "PENDING" ? (
              <>
                {qr ? (
                  <div className="flex flex-col items-center gap-2">
                    <img src={qr} alt={text("qrAlt")} className="size-52 rounded-lg" />
                    <p className="text-ui-caption text-foreground-subtle">{text("qrNotice")}</p>
                  </div>
                ) : null}
                {qrFailed ? (
                  <p role="alert" className="text-ui-caption text-warning">
                    {text("qrFailed")}
                  </p>
                ) : null}
                {payUrl ? (
                  <Button
                    onClick={() => void platform.openExternal(payUrl)}
                    data-testid="brand-recharge-pay"
                  >
                    <ExternalLink className="size-4" />
                    {text("openPayment")}
                  </Button>
                ) : null}
                {!qrCode && !payUrl ? (
                  <div className="space-y-2 text-ui-caption text-foreground-subtle">
                    <p>{text("unsupportedPayment")}</p>
                    {website ? (
                      <Button variant="outline" onClick={() => void platform.openExternal(website)}>
                        <ExternalLink className="size-4" />
                        {text("websitePayment")}
                      </Button>
                    ) : null}
                    <p>{text("websiteOrderNotice")}</p>
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="brand-recharge-verify"
                onClick={() => void verify()}
                disabled={checking}
              >
                <RefreshCw
                  className={`size-4 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`}
                />
                {text("verifyPayment")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  viewGeneration.current += 1;
                  setChecking(false);
                  setOrder(null);
                  setPayment(null);
                  setRefreshVersion((value) => value + 1);
                }}
              >
                {text("backToRecharge")}
              </Button>
            </div>
          </div>
        ) : !loading && checkout ? (
          <div className="space-y-4">
            {!checkout.enabled || checkout.balanceDisabled || checkout.methods.length === 0 ? (
              <p
                className="rounded-lg bg-surface p-3 text-ui-base"
                data-testid="brand-recharge-unavailable"
              >
                {text("paymentUnavailable")}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="brand-payment-method">{text("paymentMethod")}</Label>
                  <select
                    id="brand-payment-method"
                    data-testid="brand-recharge-payment-method"
                    className="h-9 w-full rounded-lg border border-input-border bg-input px-3 text-ui-base"
                    value={method}
                    onChange={(event) => {
                      setMethod(event.target.value);
                      setAmount("");
                    }}
                    disabled={creating || uncertain}
                  >
                    {checkout.methods.map((item) => (
                      <option key={item.paymentType} value={item.paymentType}>
                        {item.displayName} · {item.currency}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="brand-payment-amount">
                    {intl.formatMessage(
                      { id: "brandAccount.amountCurrency" },
                      { currency: selectedMethod?.currency ?? "" },
                    )}
                  </Label>
                  <Input
                    id="brand-payment-amount"
                    data-testid="brand-recharge-amount"
                    type="number"
                    inputMode="decimal"
                    min={min}
                    max={max ?? undefined}
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    disabled={creating || uncertain}
                  />
                  <p className="text-ui-caption text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: max === null ? "brandAccount.minAmount" : "brandAccount.amountRange",
                      },
                      {
                        min: formatBrandMoney(min, selectedMethod?.currency ?? "USD", locale),
                        max:
                          max === null
                            ? ""
                            : formatBrandMoney(max, selectedMethod?.currency ?? "USD", locale),
                      },
                    )}
                  </p>
                </div>
                <p className="text-ui-caption text-foreground-subtle">
                  {checkout.quoteNotice || text("quoteNotice")}
                </p>
                <Button
                  data-testid="brand-recharge-submit"
                  onClick={() => void create()}
                  disabled={!canCreate}
                >
                  {creating ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                  ) : null}
                  {text("createOrder")}
                </Button>
              </>
            )}
            {uncertain ? (
              <p
                role="alert"
                className="rounded-lg bg-warning-surface p-3 text-ui-caption text-warning-surface-foreground"
              >
                {text("createUnknown")}
              </p>
            ) : null}
            {checkout.helpText ? (
              <p className="whitespace-pre-wrap text-ui-caption text-foreground-subtle">
                {checkout.helpText}
              </p>
            ) : null}
            <div className="space-y-2">
              <h3 className="text-ui-base font-medium">{text("recentOrders")}</h3>
              {orders.length ? (
                orders.map((item) => (
                  <button
                    key={item.id}
                    data-testid={`brand-order-${item.id}`}
                    disabled={creating || selecting}
                    onClick={() => void showOrder(item.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left text-ui-caption hover:bg-surface-hover"
                  >
                    <span className="min-w-0 truncate">{item.outTradeNo}</span>
                    <span className="shrink-0">
                      {intl.formatMessage({
                        id: brandOrderStatusId(item.status),
                      })}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-ui-caption text-foreground-subtle">{text("noOrders")}</p>
              )}
            </div>
          </div>
        ) : null}
        <p className="text-ui-xs text-foreground-subtle">{text("closeNotice")}</p>
        <Button data-testid="brand-recharge-close" variant="outline" onClick={onClose}>
          {intl.formatMessage({ id: "common.close" })}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function safePaymentUrl(value: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
