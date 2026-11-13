import type { BrandOrder, BrandOrderPage } from "./contract.js";
import type { BrandPaymentActions } from "./paymentContract.js";
import type { PrivateSession } from "./secretRepo.js";
import { failure } from "./errors.js";
import { record, text } from "./httpClient.js";
import {
  balanceOrderRequest,
  checkout,
  createOrderProjection,
  order,
  orderPage,
  orderPageQuery,
  validateOrderInput,
  validateOrderMethod,
} from "./projections.js";

/** 订单请求复用账户 owner 的鉴权/结算观察端口；不维护第二份账户或余额状态。 */
export function createAccountPaymentActions(ports: {
  requireSession: () => Promise<PrivateSession>;
  loadSettings: () => Promise<void>;
  authenticated: (
    path: string,
    body?: unknown,
    expected?: PrivateSession,
  ) => Promise<{ data: unknown; session: PrivateSession }>;
  current: (expected?: PrivateSession) => Promise<PrivateSession>;
  completed: Set<string>;
  onSettled: () => Promise<unknown>;
}): BrandPaymentActions {
  const { requireSession, loadSettings, authenticated, current, completed, onSettled } = ports;
  async function observeOrders(items: BrandOrder[], session: PrivateSession) {
    let newlyCompleted = false;
    for (const item of items) {
      const key = `${session.epoch}:${item.id}`;
      if (item.status === "COMPLETED" && !completed.has(key)) {
        completed.add(key);
        newlyCompleted = true;
      }
    }
    while (completed.size > 300) completed.delete(completed.values().next().value!);
    if (newlyCompleted) await onSettled().catch(() => {});
    await current(session);
  }

  async function getCheckout() {
    const session = await requireSession();
    await loadSettings();
    const config = record((await authenticated("/payment/config", undefined, session)).data);
    if (config.enabled !== true || config.balance_disabled === true) return checkout(config);
    const info = (await authenticated("/payment/checkout-info", undefined, session)).data;
    return checkout(config, info);
  }

  async function getOrder(id: number): Promise<BrandOrder> {
    if (!Number.isSafeInteger(id) || id < 1) throw failure("invalid_input");
    const result = await authenticated(`/payment/orders/${id}`);
    const projected = order(result.data);
    await observeOrders([projected], result.session);
    return projected;
  }

  async function listOrders(input?: {
    page?: number;
    pageSize?: number;
    status?: string;
  }): Promise<BrandOrderPage> {
    const request = orderPageQuery(input);
    const result = await authenticated(`/payment/orders/my?${request.query}`);
    const projected = orderPage(result.data, request);
    await observeOrders(projected.items, result.session);
    return projected;
  }

  async function verifyOrder(outTradeNo: string) {
    if (typeof outTradeNo !== "string" || !outTradeNo || outTradeNo.length > 256)
      throw failure("invalid_input");
    const result = await authenticated("/payment/orders/verify", {
      out_trade_no: outTradeNo,
    });
    const projected = order(result.data);
    await observeOrders([projected], result.session);
    return projected;
  }

  async function createOrder(input: { amount: number; paymentType: string }) {
    validateOrderInput(input);
    const session = await requireSession();
    const available = await getCheckout();
    await current(session);
    validateOrderMethod(input, available);
    const result = await authenticated("/payment/orders", balanceOrderRequest(input), session);
    const raw = record(result.data);
    let authoritativeOrder: BrandOrder | undefined;
    if (typeof raw.order_id === "number" && raw.order_id > 0 && !text(raw.currency)) {
      // 原因：部分支付provider的建单DTO省略currency；从本人订单读取已保存币种，不能按渠道猜。
      if (!Number.isSafeInteger(raw.order_id)) throw failure("invalid_response");
      const detail = await authenticated(
        `/payment/orders/${raw.order_id}`,
        undefined,
        result.session,
      );
      authoritativeOrder = order(detail.data);
    }
    const projected = createOrderProjection(result.data, authoritativeOrder);
    if (projected.order) await observeOrders([projected.order], result.session);
    return projected;
  }

  async function cancelOrder(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw failure("invalid_input");
    const result = await authenticated(`/payment/orders/${id}/cancel`, {});
    const latest = await authenticated(`/payment/orders/${id}`, undefined, result.session);
    const projected = order(latest.data);
    await observeOrders([projected], latest.session);
    return projected;
  }

  return { getCheckout, getOrder, listOrders, verifyOrder, createOrder, cancelOrder };
}
