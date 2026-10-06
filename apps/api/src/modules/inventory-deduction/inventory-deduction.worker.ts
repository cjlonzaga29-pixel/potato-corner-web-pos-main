import { inventoryDeductionService } from './inventory-deduction.service.js';
import { INVENTORY_DEDUCTION_STALE_LOCK_MS, type InventoryDeductionCycleResult } from './inventory-deduction.types.js';

export interface InventoryDeductionWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  staleLockMs?: number;
}

const DEFAULT_BATCH_SIZE = 25;
// POS-PERF-P15 — this worker is what actually makes "inventory processing
// starts automatically on the server" true (see server.ts): a short,
// unconditional poll interval so a pending deduction is picked up within a
// couple of seconds of checkout, with no dependency on the cashier clicking
// New Sale or keeping the browser open at all.
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Single-cycle entry point — claims and deducts at most one batch, then returns. What tests and a one-shot drain script call instead of the long-running loop below. */
export function runInventoryDeductionCycle(options: InventoryDeductionWorkerOptions = {}): Promise<InventoryDeductionCycleResult> {
  return inventoryDeductionService.runCycle(options.batchSize ?? DEFAULT_BATCH_SIZE, options.staleLockMs ?? INVENTORY_DEDUCTION_STALE_LOCK_MS);
}

/**
 * Long-running poll loop. Unlike inventory-projection.worker.ts's
 * createInventoryProjectionWorker (deliberately never auto-started — that
 * feature is still dormant), this worker IS started unconditionally from
 * server.ts#start — a sale that commits with a pending deduction job must
 * never depend on any further client action to actually deduct stock.
 * `stop()` lets an in-flight cycle finish before the loop exits instead of
 * cutting a deduction off mid-batch.
 */
export function createInventoryDeductionWorker(options: InventoryDeductionWorkerOptions = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleLockMs = options.staleLockMs ?? INVENTORY_DEDUCTION_STALE_LOCK_MS;

  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await inventoryDeductionService.runCycle(batchSize, staleLockMs);
      } catch (error) {
        // A whole-cycle failure (e.g. a transient DB outage) must never
        // crash the API process or stop future cycles from being
        // attempted — each job's own claim/apply/retry bookkeeping already
        // isolates per-job failures; this is defense against a failure in
        // the claim query itself.
        console.error('Inventory deduction worker cycle failed:', error);
      }
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
