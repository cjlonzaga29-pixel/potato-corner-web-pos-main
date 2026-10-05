/**
 * POS-PERF-P15 — durable background inventory deduction worker constants.
 * Same 10s / 60s / 300s / 3-attempt retry cadence every other queue in this
 * codebase uses (src/queues/*.ts RETRY_DELAYS_MS, inventory-projection's
 * PROJECTION_RETRY_DELAYS_MS) — reused here for consistency, not reinvented.
 */
export const INVENTORY_DEDUCTION_RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
export const INVENTORY_DEDUCTION_MAX_ATTEMPTS = INVENTORY_DEDUCTION_RETRY_DELAYS_MS.length;

/** A `processing` lock older than this is assumed to belong to a dead/crashed worker and is eligible for re-claim — same value as the projection outbox's PROJECTION_STALE_LOCK_MS. */
export const INVENTORY_DEDUCTION_STALE_LOCK_MS = 5 * 60_000;

export interface InventoryDeductionCycleResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  /** Guard returned false: this worker's claim was lost to a stale-lock reclaim before it could apply the deduction. Nothing was written. */
  skipped: number;
}
