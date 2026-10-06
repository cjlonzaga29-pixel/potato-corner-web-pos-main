import { type ClaimedDeductionJobRow, inventoryDeductionRepository } from './inventory-deduction.repository.js';
import {
  INVENTORY_DEDUCTION_MAX_ATTEMPTS,
  INVENTORY_DEDUCTION_RETRY_DELAYS_MS,
  INVENTORY_DEDUCTION_STALE_LOCK_MS,
  type InventoryDeductionCycleResult,
} from './inventory-deduction.types.js';

/** Never persist a raw error object: no stack trace, no cause chain, capped length — same convention as inventory-projection.service.ts#sanitizeError. */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).slice(0, 500);
}

/**
 * Deducts a single already-claimed job. Never throws — every outcome
 * (completed, retried, failed, skipped) is persisted by the repository
 * before this returns, so a caller looping over a batch can't have one
 * job's exception abort the rest of the batch. Post-commit effects (audit
 * rows, low-stock notifications) are fired without awaiting them into the
 * cycle's own completion — same fire-and-forget convention the old
 * synchronous checkout path used for its own post-commit bookkeeping, now
 * just run here instead since nothing else is waiting on this worker.
 */
async function processJob(row: ClaimedDeductionJobRow): Promise<'completed' | 'retried' | 'failed' | 'skipped'> {
  const claimToken = row.claimToken;
  if (!claimToken) {
    // Defensive: claimBatch only ever returns rows it just stamped with a
    // token, so this should be unreachable.
    return 'skipped';
  }

  try {
    const { applied, effects } = await inventoryDeductionRepository.applyDeduction({
      jobId: row.id,
      claimToken,
      transactionId: row.transactionId,
      branchId: row.branchId,
    });
    if (!applied) {
      // Guard returned false: this worker no longer held the claim (a
      // stale-lock reclaim already gave the row to someone else). Nothing
      // was written; the row is already owned by whoever holds it now.
      return 'skipped';
    }
    void (async () => {
      for (const effect of effects) {
        await effect();
      }
    })();
    // POS-PERF-P15 — "background completion" latency: queue wait (time
    // since the checkout request created this job) plus this cycle's own
    // claim+deduct time, combined. Branch/transaction identifiers and a
    // duration only — no cart/payment data, same convention as the
    // checkout-side "POS checkout stage timing" log.
    console.warn('Inventory deduction job completed', {
      transactionId: row.transactionId,
      branchId: row.branchId,
      backgroundCompletionMs: Math.round(Date.now() - row.createdAt.getTime()),
    });
    return 'completed';
  } catch (error) {
    const attempts = row.attempts + 1;
    if (attempts >= INVENTORY_DEDUCTION_MAX_ATTEMPTS) {
      await inventoryDeductionRepository.recordFailure({
        jobId: row.id,
        transactionId: row.transactionId,
        claimToken,
        attempts,
        nextStatus: 'failed',
        lastError: sanitizeError(error),
        nextAttemptAt: null,
      });
      console.error('Inventory deduction job exhausted retries — marked failed, visible via inventory_deduction_status', {
        transactionId: row.transactionId,
        branchId: row.branchId,
        attempts,
      });
      return 'failed';
    }

    const delayMs = INVENTORY_DEDUCTION_RETRY_DELAYS_MS[attempts - 1] ?? INVENTORY_DEDUCTION_RETRY_DELAYS_MS.at(-1) ?? 300_000;
    await inventoryDeductionRepository.recordFailure({
      jobId: row.id,
      transactionId: row.transactionId,
      claimToken,
      attempts,
      nextStatus: 'pending',
      lastError: sanitizeError(error),
      nextAttemptAt: new Date(Date.now() + delayMs),
    });
    return 'retried';
  }
}

export const inventoryDeductionService = {
  /**
   * Claims up to `batchSize` eligible jobs and deducts each one, in claimed
   * (createdAt) order, sequentially — no cross-job parallelism, matching
   * inventory-projection.service.ts#runCycle's same reasoning.
   */
  async runCycle(batchSize: number, staleLockMs: number = INVENTORY_DEDUCTION_STALE_LOCK_MS): Promise<InventoryDeductionCycleResult> {
    const claimed = await inventoryDeductionRepository.claimBatch(batchSize, staleLockMs);
    const result: InventoryDeductionCycleResult = { claimed: claimed.length, completed: 0, retried: 0, failed: 0, skipped: 0 };

    for (const row of claimed) {
      const outcome = await processJob(row);
      result[outcome] += 1;
    }
    return result;
  },
};
