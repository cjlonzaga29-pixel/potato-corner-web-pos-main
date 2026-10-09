import { Prisma } from '@prisma/client';
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

/**
 * POS-PERF-P29R2 — distinct from a payload conflict: two requests under the
 * SAME key+actor+payload arrived close enough together that the first
 * hadn't finished (and recorded its resultId) yet when this one reached the
 * idempotency check. Safe to retry — this attempt was rejected before ever
 * touching PIN verification or evidence, so nothing it would need to "undo"
 * was consumed.
 */
export class InventoryIdempotencyInProgressError extends Error {
  constructor() {
    super('This Idempotency-Key is still being processed by a concurrent request — retry shortly');
  }
}

export interface IdempotencyCheck {
  /** Set when an identical prior attempt already completed — the caller should return this id's cached result without writing anything. */
  cachedResultId: string | null;
}

/**
 * Call before doing any stock-mutating work. Throws
 * InventoryIdempotencyConflictError on a same-key/different-payload
 * conflict, or InventoryIdempotencyInProgressError if a concurrent request
 * under the identical key+payload is still mid-flight. Returns a non-null
 * cachedResultId when this exact (key, actor, payload) already completed —
 * the caller short-circuits before touching PIN verification or evidence at
 * all, since a replay of an already-applied operation should not consume
 * (or require) a fresh token/evidence row.
 *
 * Attempts an INSERT first rather than find-then-create: two concurrent
 * requests under the same key+actor racing a plain SELECT-then-INSERT could
 * both observe "no existing row" and both try to INSERT, which the unique
 * constraint on (idempotencyKey, actorUserId) would turn into an unhandled
 * P2002 for whichever loses that race. Catching P2002 here and re-reading
 * the row the winner just inserted closes that window — the loser always
 * resolves through the same cachedResultId/conflict/in-progress outcomes
 * the winner itself would see on a retry, never a raw database error.
 */
export async function checkIdempotency(params: {
  idempotencyKey: string | undefined;
  actorUserId: string;
  branchId: string;
  operation: string;
  payloadHash: string;
}): Promise<IdempotencyCheck> {
  if (!params.idempotencyKey) return { cachedResultId: null };

  let existing: { payloadHash: string; resultId: string | null } | null = null;
  try {
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
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    existing = await prisma.inventoryOperationAttempt.findUniqueOrThrow({
      where: { idempotencyKey_actorUserId: { idempotencyKey: params.idempotencyKey, actorUserId: params.actorUserId } },
    });
  }

  if (existing.payloadHash !== params.payloadHash) {
    throw new InventoryIdempotencyConflictError();
  }
  if (existing.resultId === null) {
    throw new InventoryIdempotencyInProgressError();
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
