import { type ClaimedOutboxRow, inventoryProjectionRepository } from './inventory-projection.repository.js';
import {
  PROJECTION_MAX_ATTEMPTS,
  PROJECTION_RETRY_DELAYS_MS,
  PROJECTION_STALE_LOCK_MS,
  type ProjectionCycleResult,
} from './inventory-projection.types.js';

/**
 * Never persist a raw error object: no stack trace, no cause chain, capped
 * length so nothing resembling a secret or a full trace lands in the
 * `lastError` column.
 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).slice(0, 500);
}

/**
 * Projects a single already-claimed row. Never throws — every outcome
 * (deferred, processed, retried, stuck) is persisted by the repository
 * before this returns, so a caller looping over a batch can't have one row's
 * exception abort the rest of the batch.
 */
async function processRow(row: ClaimedOutboxRow): Promise<'processed' | 'deferred' | 'retried' | 'stuck'> {
  const claimToken = row.claimToken;
  if (!claimToken) {
    // Defensive: claimBatch only ever returns rows it just stamped with a
    // token, so this should be unreachable. If it somehow isn't, there is
    // no ownership to act under, so touch nothing.
    return 'deferred';
  }

  const mapping = await inventoryProjectionRepository.findAcceptedMapping(row.movement.ingredientId);
  if (!mapping || !mapping.inventoryItemId) {
    await inventoryProjectionRepository.deferRow(row.id, claimToken);
    return 'deferred';
  }

  try {
    const applied = await inventoryProjectionRepository.applyProjection({
      outboxId: row.id,
      claimToken,
      branchId: row.movement.branchId,
      inventoryItemId: mapping.inventoryItemId,
      quantityChange: row.movement.quantityChange,
      movementCreatedAt: row.movement.createdAt,
    });
    // Guard returned false: this worker no longer held the claim (e.g. a
    // stale-lock recovery reclaimed it elsewhere first). Nothing was
    // written; the row is already owned by whoever holds it now.
    return applied ? 'processed' : 'deferred';
  } catch (error) {
    const attempts = row.attempts + 1;
    if (attempts >= PROJECTION_MAX_ATTEMPTS) {
      await inventoryProjectionRepository.recordFailure({
        outboxId: row.id,
        claimToken,
        attempts,
        nextStatus: 'stuck',
        lastError: sanitizeError(error),
        nextAttemptAt: null,
      });
      return 'stuck';
    }

    const delayMs = PROJECTION_RETRY_DELAYS_MS[attempts - 1] ?? PROJECTION_RETRY_DELAYS_MS.at(-1) ?? 300_000;
    await inventoryProjectionRepository.recordFailure({
      outboxId: row.id,
      claimToken,
      attempts,
      nextStatus: 'pending',
      lastError: sanitizeError(error),
      nextAttemptAt: new Date(Date.now() + delayMs),
    });
    return 'retried';
  }
}

export const inventoryProjectionService = {
  /**
   * Claims up to `batchSize` eligible rows and projects each one, in the
   * claimed (createdAt) order, sequentially — no cross-row parallelism, so
   * two rows for the same ingredient/branch always apply in the order their
   * movements were created.
   */
  async runCycle(batchSize: number, staleLockMs: number = PROJECTION_STALE_LOCK_MS): Promise<ProjectionCycleResult> {
    const claimed = await inventoryProjectionRepository.claimBatch(batchSize, staleLockMs);
    const result: ProjectionCycleResult = { claimed: claimed.length, processed: 0, deferred: 0, retried: 0, stuck: 0 };

    for (const row of claimed) {
      const outcome = await processRow(row);
      result[outcome] += 1;
    }
    return result;
  },
};
