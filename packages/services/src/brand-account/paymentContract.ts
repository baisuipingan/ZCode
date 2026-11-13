/** 订单与支付投影合同；仍由同一BrandAccountService拥有鉴权和到账同步。 */
export interface BrandPaymentMethod {
  paymentType: string;
  displayName: string;
  currency: string;
  feeRate: number;
  singleMin: number;
  singleMax: number;
  dailyLimit: number;
}

export interface BrandCheckout {
  enabled: boolean;
  balanceDisabled: boolean;
  methods: BrandPaymentMethod[];
  minAmount: number;
  maxAmount: number;
  orderTimeoutMinutes: number;
  helpText: string;
  /** 客户端不复制服务端折扣、赠送、换汇算法；下单后展示权威金额。 */
  quoteNotice: string;
}

export interface BrandOrder {
  id: number;
  outTradeNo: string;
  status: string;
  orderType: string;
  paymentType: string;
  /** amount 已含赠送，单位为 USD 等价到账额。 */
  creditedUsd: number;
  bonusUsd: number;
  /** 实付金额以 paymentCurrency 计价，与账户展示币种无关。 */
  payAmount: number;
  paymentCurrency: string;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  completedAt: string | null;
}

export interface BrandOrderPage {
  items: BrandOrder[];
  total: number;
  page: number;
  pageSize: number;
}

export type BrandCreateOrderResult =
  | {
      kind: "payment";
      order: BrandOrder;
      payUrl: string | null;
      qrCode: string | null;
    }
  | {
      kind: "unsupported";
      reason: "oauth" | "jsapi" | "provider_sdk" | "no_payment_action";
      order: BrandOrder | null;
    };

/** 仅本机 Host 提供；Renderer 不接收任何登录或推理凭据。 */
export interface BrandPaymentActions {
  getCheckout(): Promise<BrandCheckout>;
  listOrders(input?: {
    page?: number;
    pageSize?: number;
    status?: string;
  }): Promise<BrandOrderPage>;
  getOrder(id: number): Promise<BrandOrder>;
  verifyOrder(outTradeNo: string): Promise<BrandOrder>;
  /** amount 为所选支付渠道币种的支付基数，非 USD 到账额。 */
  createOrder(input: { amount: number; paymentType: string }): Promise<BrandCreateOrderResult>;
  cancelOrder(id: number): Promise<BrandOrder>;
}
