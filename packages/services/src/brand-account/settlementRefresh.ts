import {
  sameManagedBillingBinding,
  type ManagedBillingBinding,
} from "@zcode/shared/model-selection";

const SETTLEMENT_BATCH_MS = 200;
const SETTLEMENT_MIN_INTERVAL_MS = 1_000;

/** 只合并展示同步信号；余额和用量仍由各自现有权威读取者维护。 */
export function createSettlementRefresh(options: {
  currentBinding(): ManagedBillingBinding | null;
  refresh(): Promise<unknown>;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ManagedBillingBinding | null = null;
  let lastReadAt = 0;
  function reset() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
    lastReadAt = 0;
  }
  return {
    reset,
    enqueue(binding: ManagedBillingBinding) {
      if (!sameManagedBillingBinding(binding, options.currentBinding() ?? undefined)) return;
      pending = structuredClone(binding);
      if (timer) return;
      timer = setTimeout(
        () => {
          timer = null;
          const captured = pending;
          pending = null;
          // 原因：批处理期间可换账号或授权scope；迟到事件不能刷新新归属。
          if (
            !captured ||
            !sameManagedBillingBinding(captured, options.currentBinding() ?? undefined)
          )
            return;
          lastReadAt = Date.now();
          void options.refresh().catch(() => {});
        },
        Math.max(SETTLEMENT_BATCH_MS, SETTLEMENT_MIN_INTERVAL_MS - (Date.now() - lastReadAt)),
      );
      timer.unref?.();
    },
  };
}
