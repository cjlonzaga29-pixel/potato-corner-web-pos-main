import { randomUUID } from 'node:crypto';
import { Prisma, type InventoryIdentityMapping, type InventoryProjectionOutboxStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { PROJECTION_DEFERRED_RETRY_DELAY_MS } from './inventory-projection.types.js';

const CLAIMABLE_STATUSES: InventoryProjectionOutboxStatus[] = ['pending', 'deferred'];

const claimInclude = {
  movement: true,
} satisfies Prisma.InventoryProjectionOutboxInclude;

export type ClaimedOutboxRow = Prisma.InventoryProjectionOutboxGetPayload<{ include: typeof claimInclude }> & {
  claimToken: string | null;
};

/**
 * Rows eligible for a claim attempt this cycle: `pending`/`deferred` rows
 * whose backoff has elapsed (or that never had one), plus `processing` rows
 * whose lock is older than `staleLockMs` — a worker that crashed or timed
 * out mid-projection eventually releases its claim to whoever polls next.
 */
function claimableWhere(now: Date, staleCutoff: Date): Prisma.InventoryProjectionOutboxWhereInput {
  return {
    OR: [
      {
        status: { in: CLAIMABLE_STATUSES },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      { status: 'processing', lockedAt: { lt: staleCutoff } },
    ],
  };
}

export const inventoryProjectionRepository = {
  /**
   * Two-phase claim, now with a durable per-attempt ownership token
   * (CR-010A.2A). Phase 1 is a plain, unlocked read that picks candidate ids
   * in deterministic `createdAt` order (requirement: process in createdAt
   * order). Phase 2 flips only those ids into `processing`, stamping a fresh
   * `claimToken` + `lockedAt`, via `updateMany` scoped by the same
   * eligibility predicate — Postgres evaluates each row's WHERE under a row
   * lock during the UPDATE itself, so if two workers race for the same id,
   * only one `updateMany` actually changes it; the other affects 0 rows for
   * that id. Phase 3 re-reads by `id + claimToken` (this call's freshly
   * generated token, not merely `status = 'processing'`) — a stale-lock
   * reclaim that flips the same id to `processing` under a *different*
   * token can never be picked up here, so two workers can never both
   * believe they hold the same row.
   */
  async claimBatch(batchSize: number, staleLockMs: number): Promise<ClaimedOutboxRow[]> {
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - staleLockMs);
    const claimToken = randomUUID();

    const candidates = await prisma.inventoryProjectionOutbox.findMany({
      where: claimableWhere(now, staleCutoff),
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true },
    });
    if (candidates.length === 0) return [];
    const candidateIds = candidates.map((row) => row.id);

    await prisma.inventoryProjectionOutbox.updateMany({
      where: { id: { in: candidateIds }, ...claimableWhere(now, staleCutoff) },
      data: { status: 'processing', claimToken, lockedAt: now },
    });

    const claimedRows = await prisma.inventoryProjectionOutbox.findMany({
      where: { id: { in: candidateIds }, claimToken },
      include: claimInclude,
    });
    const claimedById = new Map(claimedRows.map((row) => [row.id, row]));
    return candidateIds.map((id) => claimedById.get(id)).filter((row): row is ClaimedOutboxRow => row !== undefined);
  },

  /**
   * A mapping only counts as resolved for projection purposes if it has
   * both an accepted status (auto- or manually-matched — PENDING/AMBIGUOUS/
   * REJECTED never qualify) AND a non-null `inventoryItemId` (belt-and-
   * suspenders: the schema already makes `inventoryItemId` nullable
   * specifically for unresolved rows, but status is the authoritative
   * signal per the InventoryIdentityMapping doc comment).
   */
  async findAcceptedMapping(legacyIngredientId: string): Promise<InventoryIdentityMapping | null> {
    const mapping = await prisma.inventoryIdentityMapping.findUnique({ where: { legacyIngredientId } });
    if (!mapping || !mapping.inventoryItemId) return null;
    if (mapping.mappingStatus !== 'AUTO_MATCHED' && mapping.mappingStatus !== 'MANUALLY_MATCHED') return null;
    return mapping;
  },

  /**
   * Releases a claimed row back to `deferred` without touching `attempts` —
   * a missing/unresolved mapping is not a processing failure (requirement:
   * "do not count it as a failed attempt"), it just means this row isn't
   * ready yet. `nextAttemptAt` is pushed out by
   * `PROJECTION_DEFERRED_RETRY_DELAY_MS` so an unresolved row isn't
   * reclaimed on every single poll cycle. Guarded on `id + status =
   * 'processing' + claimToken` (CR-010A.2A): if this worker's token no
   * longer matches (ownership lost to a stale-lock reclaim), the update
   * affects 0 rows and the row is left alone for whoever holds it now.
   */
  async deferRow(outboxId: string, claimToken: string): Promise<void> {
    await prisma.inventoryProjectionOutbox.updateMany({
      where: { id: outboxId, status: 'processing', claimToken },
      data: { status: 'deferred', claimToken: null, lockedAt: null, nextAttemptAt: new Date(Date.now() + PROJECTION_DEFERRED_RETRY_DELAY_MS) },
    });
  },

  /**
   * The only place InventoryStock is ever written by this consumer. Both
   * writes — flipping the outbox row to `processed` and applying
   * `quantityChange` — happen in one transaction, and the outbox flip is a
   * conditional `updateMany` guarded on `id + status: 'processing' +
   * claimToken` (CR-010A.2A: ownership must still hold, not merely "some
   * row happens to be processing"). If the guard affects zero rows (this
   * worker no longer holds the claim — e.g. a stale-lock reclaim already
   * gave the row to someone else), the function returns `false` *before*
   * touching InventoryStock, so a processed movement's quantityChange can
   * never be applied twice and can never be applied by a worker that has
   * lost ownership.
   */
  async applyProjection(params: {
    outboxId: string;
    claimToken: string;
    branchId: string;
    inventoryItemId: string;
    quantityChange: Prisma.Decimal;
    movementCreatedAt: Date;
  }): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const guard = await tx.inventoryProjectionOutbox.updateMany({
        where: { id: params.outboxId, status: 'processing', claimToken: params.claimToken },
        data: { status: 'processed', processedAt: new Date(), claimToken: null, lockedAt: null },
      });
      if (guard.count === 0) return false;

      // CR-010A.3: a rebuild folds every movement up to its watermark
      // (rebuiltThroughAt) directly into quantityOnHand. If this movement
      // predates that watermark, its effect is already baked in — applying
      // the increment again would double-count it. The outbox row is still
      // finalized as processed above; only the InventoryStock write is
      // skipped.
      const existing = await tx.inventoryStock.findUnique({
        where: { branchId_inventoryItemId: { branchId: params.branchId, inventoryItemId: params.inventoryItemId } },
        select: { rebuiltThroughAt: true },
      });
      if (existing?.rebuiltThroughAt && params.movementCreatedAt <= existing.rebuiltThroughAt) {
        return true;
      }

      await tx.inventoryStock.upsert({
        where: { branchId_inventoryItemId: { branchId: params.branchId, inventoryItemId: params.inventoryItemId } },
        create: {
          branchId: params.branchId,
          inventoryItemId: params.inventoryItemId,
          quantityOnHand: params.quantityChange,
          version: 1,
        },
        update: {
          quantityOnHand: { increment: params.quantityChange },
          version: { increment: 1 },
        },
      });
      return true;
    });
  },

  /**
   * Records a real processing failure (not a missing mapping). Below
   * `PROJECTION_MAX_ATTEMPTS` the row goes back to `pending` with a bounded
   * backoff (`nextAttemptAt`); at/after the max it goes to `stuck` and stops
   * being reclaimed automatically. `lastError` must already be sanitized by
   * the caller — this method just persists whatever string it's given.
   * Guarded on `id + status = 'processing' + claimToken` (CR-010A.2A): an
   * expired owner that lost the row to a reclaim cannot record a failure
   * (or a stuck/retry transition) against the new owner's in-flight claim.
   */
  async recordFailure(params: {
    outboxId: string;
    claimToken: string;
    attempts: number;
    nextStatus: 'pending' | 'stuck';
    lastError: string;
    nextAttemptAt: Date | null;
  }): Promise<void> {
    await prisma.inventoryProjectionOutbox.updateMany({
      where: { id: params.outboxId, status: 'processing', claimToken: params.claimToken },
      data: {
        attempts: params.attempts,
        lastError: params.lastError,
        status: params.nextStatus,
        nextAttemptAt: params.nextAttemptAt,
        claimToken: null,
        lockedAt: null,
      },
    });
  },
};
