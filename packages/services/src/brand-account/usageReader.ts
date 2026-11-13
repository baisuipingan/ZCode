import type { BrandUsageSnapshot } from "./contract.js";
import { errorProjection } from "./errors.js";
import { usageRecords } from "./usageProjection.js";

export const emptyBrandUsage = (): BrandUsageSnapshot => ({
  status: "unknown",
  items: [],
  fetchedAt: null,
  error: null,
});

/** 账户服务的私有读取协作者；公开snapshot仍是唯一展示事实，不持有秘密或第二账本。 */
export function createBrandUsageReader(options: {
  available(): boolean;
  readScope(): Promise<{ keyId: string; policyRevision: string }>;
  read(keyId: string): Promise<unknown>;
  snapshot(): BrandUsageSnapshot;
  publish(value: BrandUsageSnapshot): void;
}) {
  let generation = 0;
  let flight: Promise<void> | null = null;
  let followupFlight: Promise<void> | null = null;
  async function refresh(afterSettlement = false): Promise<void> {
    if (!options.available()) return;
    if (afterSettlement && flight) {
      if (!followupFlight) {
        // 原因：单飞不能把结算前已发出的usage当作结算后的读取。
        generation += 1;
        const queued = generation;
        const pending = flight
          .catch(() => {})
          .then(async () => {
            if (followupFlight === pending) followupFlight = null;
            if (queued !== generation) return;
            await refresh();
          });
        followupFlight = pending;
      }
      return followupFlight;
    }
    if (flight) return flight;
    const started = generation;
    const pending = (async () => {
      try {
        const scope = await options.readScope();
        if (started !== generation) return;
        options.publish({ ...options.snapshot(), status: "syncing", error: null });
        const items = usageRecords(await options.read(scope.keyId));
        const current = await options.readScope();
        if (
          started !== generation ||
          current.keyId !== scope.keyId ||
          current.policyRevision !== scope.policyRevision
        )
          return;
        options.publish({
          status: "fresh",
          items,
          fetchedAt: new Date().toISOString(),
          error: null,
        });
      } catch (error) {
        if (started !== generation) return;
        const current = options.snapshot();
        options.publish({
          ...current,
          status: current.fetchedAt ? "stale" : "unavailable",
          error: errorProjection(error),
        });
      }
    })();
    flight = pending;
    try {
      await pending;
    } finally {
      if (flight === pending) flight = null;
    }
  }
  return {
    refresh,
    invalidate: () => {
      generation += 1;
      flight = null;
      followupFlight = null;
      options.publish(emptyBrandUsage());
    },
  };
}
