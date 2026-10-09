import { prisma } from './prisma.js';

/**
 * POS-PERF-P29 — idempotency ledger for the receive/adjust/waste manual
 * inventory endpoints (InventoryOperationAttempt), mirroring expenses
 * module's Idempotency-Key convention (expenses.service.ts). A retry with
 * the same key AND the same payloadHash replays the original resultId; the
 * same key with a DIFFERENT payloadHash is a conflict — the caller changed
 * the request body under an already-used key, which must never silently
 * apply the new body as if it were the first attempt.
 */
export class InventoryIdempotencyConflictError extends Error {
  constructor() {
    super('This Idempotency-Key was already used with a different request body');
  }
}

export interface IdempotencyCheck {
  /** Set when an identical prior attempt already completed — the caller should return this id's cached result without writing anything. */
  cachedResultId: string | null;
}

/**
 * Call before doing any stock-mutating work. Throws InventoryIdempotencyConflictError
 * on a same-key/different-payload conflict. Returns a non-null cachedResultId
 * when this exact (key, actor, payload) already succeeded — the caller
 * short-circuits before touching PIN verification or evidence at all, since
 * a replay of an already-applied operation should not consume (or require)
 * a fresh token/evidence row.
 */
export async function checkIdempotency(params: {
  idempotencyKey: string | undefined;
  actorUserId: string;
  branchId: string;
  operation: string;
  payloadHash: string;
}): Promise<IdempotencyCheck> {
  if (!params.idempotencyKey) return { cachedResultId: null };

  const existing = await prisma.inventoryOperationAttempt.findUnique({
    where: { idempotencyKey_actorUserId: { idempotencyKey: params.idempotencyKey, actorUserId: params.actorUserId } },
  });
  if (!existing) {
    await prisma.inventoryOperationAttempt.create({
      data: {
        idempotencyKey: params.idempotencyKey,
        actorUserId: params.actorUserId,
        branchId: params.branchId,
        operation: params.operation as never,
        payloadHash: params.payloadHash,
      },
    });
    return { cachedResultId: null };
  }
  if (existing.payloadHash !== params.payloadHash) {
    throw new InventoryIdempotencyConflictError();
  }
  return { cachedResultId: existing.resultId };
}

export async function recordIdempotencyResult(idempotencyKey: string | undefined, actorUserId: string, resultId: string): Promise<void> {
  if (!idempotencyKey) return;
  await prisma.inventoryOperationAttempt
    .update({ where: { idempotencyKey_actorUserId: { idempotencyKey, actorUserId } }, data: { resultId } })
    .catch((error: unknown) => {
      console.error('Failed to record idempotency result:', error);
    });
}
