import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P2R -- opt-in, per-checkout-request latency breakdown.
 *
 * Deliberately NOT a module-level/global mutable store: each call to
 * createCheckoutLatencyRecorder returns its own closure-scoped instance,
 * threaded explicitly through createTransaction/deductInventoryForSale as a
 * parameter. Two concurrent checkouts therefore always get two independent
 * instances with their own correlationId and stage map -- there is nothing
 * shared to race on.
 *
 * When disabled (the default), every method is a no-op and callers that
 * guard on `.enabled` first (see timeStage) skip the performance.now() calls
 * entirely, so the inactive cost is a single boolean read per stage.
 */
export interface CheckoutLatencyRecorder {
  readonly enabled: boolean;
  readonly correlationId: string | null;
  mark(stage: string, durationMs: number): void;
  snapshot(): Record<string, number>;
}

const DISABLED_RECORDER: CheckoutLatencyRecorder = {
  enabled: false,
  correlationId: null,
  mark() {
    /* no-op when disabled */
  },
  snapshot() {
    return {};
  },
};

export function createCheckoutLatencyRecorder(enabled: boolean): CheckoutLatencyRecorder {
  if (!enabled) return DISABLED_RECORDER;

  const stages: Record<string, number> = {};
  const correlationId = randomUUID();
  return {
    enabled: true,
    correlationId,
    mark(stage, durationMs) {
      stages[stage] = Math.round(durationMs);
    },
    snapshot() {
      return { ...stages };
    },
  };
}

/**
 * Wraps an existing await boundary with a named timer. Never changes `fn`'s
 * control flow, resolution value, or rejection -- the same promise/value/error
 * propagates whether or not the recorder is enabled, and the finally block
 * records the stage duration even when `fn` throws, so a rejected stage still
 * shows up in the breakdown.
 */
export async function timeStage<T>(recorder: CheckoutLatencyRecorder, stage: string, fn: () => Promise<T>): Promise<T> {
  if (!recorder.enabled) return fn();
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    recorder.mark(stage, performance.now() - startedAt);
  }
}
