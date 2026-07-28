import { inventoryProjectionService } from './inventory-projection.service.js';
import { PROJECTION_STALE_LOCK_MS, type ProjectionCycleResult } from './inventory-projection.types.js';

export interface InventoryProjectionWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  staleLockMs?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Single-cycle entry point — claims and projects at most one batch, then
 * returns. What tests and one-shot scripts (e.g. a drain script) call
 * instead of the long-running loop below.
 */
export function runProjectionCycle(options: InventoryProjectionWorkerOptions = {}): Promise<ProjectionCycleResult> {
  return inventoryProjectionService.runCycle(options.batchSize ?? DEFAULT_BATCH_SIZE, options.staleLockMs ?? PROJECTION_STALE_LOCK_MS);
}

/**
 * Long-running poll loop. Nothing in this module calls `start()` — a caller
 * (a script, or a future explicitly-wired startup hook gated by
 * `config.inventoryProjectionOutboxEnabled`) has to invoke it; there is no
 * automatic startup. `stop()` lets an in-flight cycle finish before the loop
 * exits instead of cutting a projection off mid-batch.
 */
export function createInventoryProjectionWorker(options: InventoryProjectionWorkerOptions = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleLockMs = options.staleLockMs ?? PROJECTION_STALE_LOCK_MS;

  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  async function loop(): Promise<void> {
    while (!stopped) {
      await inventoryProjectionService.runCycle(batchSize, staleLockMs);
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return {
    start(): void {
      if (loopPromise) return;
      stopped = false;
      loopPromise = loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      await loopPromise;
      loopPromise = null;
    },
  };
}
