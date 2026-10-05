import { randomUUID } from 'node:crypto';
import { Prisma, type InventoryDeductionJobStatus } from '@prisma/client';
import { INVENTORY_DEDUCTION_STATUS } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { universalInventoryRepository } from '../universal-inventory/universal-inventory.repository.js';
import { inventoryStockLockId } from '../../lib/pg-lock.js';
import { enqueueRawNotificationJob } from '../../queues/notification.queue.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { computeDeductionTotals, sortedDeductionTotalEntries, type DeductionTotal } from '../../lib/deduction-totals.js';
import type { BomDeductionLine } from '../shadow-bom-deduction/shadow-bom-deduction.types.js';

const CLAIMABLE_STATUSES: InventoryDeductionJobStatus[] = ['pending'];

const claimInclude = {
  transaction: { select: { items: { select: { deductionSnapshot: true } } } },
} satisfies Prisma.InventoryDeductionJobInclude;

export type ClaimedDeductionJobRow = Prisma.InventoryDeductionJobGetPayload<{ include: typeof claimInclude }> & {
  claimToken: string | null;
};

type DeductionSnapshotEntry = { inventoryItemId: string; quantity: number; baseUnitId: string };

/** Recomputes the same {inventoryItemId -> {quantity, baseUnitId}} totals the sale reserved at checkout time, from TransactionItem.deductionSnapshot — the immutable record of exactly what that sale needs to deduct (CR-004). */
function totalsFromSnapshots(items: { deductionSnapshot: unknown }[]): Map<string, DeductionTotal> {
  const lines = items.map((item) => ({
    lines: ((item.deductionSnapshot as DeductionSnapshotEntry[] | null) ?? []).map(
      (entry): BomDeductionLine => ({ inventoryItemId: entry.inventoryItemId, baseUnitId: entry.baseUnitId, quantity: entry.quantity }),
    ),
  }));
  return computeDeductionTotals(lines);
}

/**
 * Rows eligible for a claim attempt this cycle: `pending` rows whose
 * `nextAttemptAt` backoff has elapsed (or was never set — a first attempt),
 * plus `processing` rows whose lock is older than `staleLockMs` — a worker
 * that crashed or restarted mid-deduction eventually releases its claim to
 * whoever polls next. Without the `nextAttemptAt` gate here, recordFailure's
 * bounded backoff would be computed and persisted but never actually
 * enforced — a retried job would be immediately reclaimable on the very
 * next poll cycle instead of waiting out its delay.
 */
function claimableWhere(now: Date, staleCutoff: Date): Prisma.InventoryDeductionJobWhereInput {
  return {
    OR: [
      { status: { in: CLAIMABLE_STATUSES }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: 'processing', lockedAt: { lt: staleCutoff } },
    ],
  };
}

export const inventoryDeductionRepository = {
  /**
   * Two-phase claim with a durable per-attempt ownership token — identical
   * shape to inventory-projection.repository.ts#claimBatch (CR-010A.2A):
   * phase 1 is an unlocked read picking candidate ids in createdAt order;
   * phase 2 flips only those ids to `processing` via an `updateMany` scoped
   * by the same eligibility predicate (Postgres evaluates each row's WHERE
   * under a row lock during the UPDATE, so two workers racing for the same
   * id can never both succeed); phase 3 re-reads by `id + this call's fresh
   * claimToken`, so a stale-lock reclaim that already gave the row to a
   * different token can never be picked up here.
   */
  async claimBatch(batchSize: number, staleLockMs: number): Promise<ClaimedDeductionJobRow[]> {
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - staleLockMs);
    const claimToken = randomUUID();

    const candidates = await prisma.inventoryDeductionJob.findMany({
      where: claimableWhere(now, staleCutoff),
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true },
    });
    if (candidates.length === 0) return [];
    const candidateIds = candidates.map((row) => row.id);

    await prisma.inventoryDeductionJob.updateMany({
      where: { id: { in: candidateIds }, ...claimableWhere(now, staleCutoff) },
      data: { status: 'processing', claimToken, lockedAt: now },
    });

    const claimedRows = await prisma.inventoryDeductionJob.findMany({
      where: { id: { in: candidateIds }, claimToken },
      include: claimInclude,
    });
    const claimedById = new Map(claimedRows.map((row) => [row.id, row]));
    return candidateIds.map((id) => claimedById.get(id)).filter((row): row is ClaimedDeductionJobRow => row !== undefined);
  },

  /**
   * The real inventory deduction: decrements quantityOnHand AND releases
   * the matching quantityReserved in the same update, writes the SALE
   * ledger movement, and flips both the job and its Transaction to
   * `completed` — all inside one DB transaction. Still takes
   * pg_advisory_xact_lock per ingredient (inventoryStockLockId, same
   * branch-scoped key universal-inventory.repository.ts#lockAndGetStock and
   * the old synchronous deduction both used) before its read: unlike
   * reserveStockForSale's single conditional UPDATE (safe on its own
   * because the check and the increment are the same atomic statement),
   * this path reads quantityOnHand/quantityReserved/unitCost first and
   * writes a derived value afterward — a genuine read-then-write that must
   * serialize against any other reader/writer of this same row (a manual
   * adjustment/waste/transfer, or another worker cycle) via the lock, not
   * just against itself.
   *
   * The job->completed flip is a conditional `updateMany` guarded on
   * `id + status: 'processing' + claimToken` (ownership must still hold).
   * If that guard affects zero rows, the function returns `applied: false`
   * *before* touching InventoryStock — this worker lost the claim to a
   * stale-lock reclaim, so nothing here can be double-applied.
   */
  async applyDeduction(params: {
    jobId: string;
    claimToken: string;
    transactionId: string;
    branchId: string;
  }): Promise<{ applied: boolean; effects: Array<() => Promise<void>> }> {
    return prisma.$transaction(
      async (tx) => {
        const guard = await tx.inventoryDeductionJob.updateMany({
          where: { id: params.jobId, status: 'processing', claimToken: params.claimToken },
          data: { status: 'completed', processedAt: new Date(), claimToken: null, lockedAt: null },
        });
        if (guard.count === 0) return { applied: false, effects: [] };

        const items = await tx.transactionItem.findMany({
          where: { transactionId: params.transactionId },
          select: { deductionSnapshot: true },
        });
        const totals = totalsFromSnapshots(items);
        const sortedEntries = sortedDeductionTotalEntries(totals);
        const inventoryItemIds = sortedEntries.map(([id]) => id);

        const itemNames = new Map(
          (await tx.inventoryItem.findMany({ where: { id: { in: inventoryItemIds } }, select: { id: true, name: true } })).map((i) => [
            i.id,
            i.name,
          ]),
        );

        for (const inventoryItemId of inventoryItemIds) {
          const lockId = inventoryStockLockId(params.branchId, inventoryItemId);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
        }

        const stockRows = await tx.inventoryStock.findMany({
          where: { branchId: params.branchId, inventoryItemId: { in: inventoryItemIds } },
        });
        const stockByItemId = new Map(stockRows.map((row) => [row.inventoryItemId, row]));

        const effects: Array<() => Promise<void>> = [];
        const movementInputs: Parameters<typeof universalInventoryRepository.createStockMovements>[0] = [];

        for (const [inventoryItemId, { quantity, baseUnitId }] of sortedEntries) {
          const stock = stockByItemId.get(inventoryItemId);
          const itemName = itemNames.get(inventoryItemId) ?? inventoryItemId;
          // Defensive only: reserveStockForSale already guaranteed
          // quantityOnHand - quantityReserved >= quantity at checkout time,
          // and every other writer of this row (adjustStock/wasteStock/
          // transferStock) is required to respect quantityReserved too (see
          // universal-inventory.service.ts) — so this should be
          // unreachable. If it's ever violated anyway (a writer bug
          // elsewhere), fail this item's deduction rather than drive
          // quantityOnHand negative; the job retries/eventually surfaces as
          // `failed`, which is visible via the existing admin pattern
          // (view-transaction-detail-dialog.tsx's inventory_deduction_status
          // badge) instead of silently corrupting stock.
          if (!stock || stock.quantityOnHand.lessThan(quantity)) {
            throw new Error(`Deduction would drive ${itemName} (${inventoryItemId}) below zero at branch ${params.branchId}`);
          }

          const updated = await tx.inventoryStock.update({
            where: { branchId_inventoryItemId: { branchId: params.branchId, inventoryItemId } },
            data: {
              quantityOnHand: { decrement: quantity },
              // Releases this sale's reservation in the same statement as
              // the real deduction — never a separate write, so there is no
              // window where quantityOnHand has moved but the reservation
              // hasn't been released yet (or vice versa). Floored at 0 via
              // the same defensive reasoning as the on-hand check above.
              quantityReserved: { decrement: Math.min(quantity, stock.quantityReserved.toNumber()) },
              version: { increment: 1 },
            },
          });

          const unitCost = stock.unitCost;
          const totalCost = unitCost ? unitCost.mul(quantity) : null;

          movementInputs.push({
            branchId: params.branchId,
            inventoryItemId,
            movementType: 'SALE',
            quantityChange: new Prisma.Decimal(quantity).negated(),
            quantityBefore: stock.quantityOnHand,
            quantityAfter: updated.quantityOnHand,
            unitId: baseUnitId,
            referenceType: 'transaction',
            referenceId: params.transactionId,
            unitCost: unitCost ?? undefined,
            totalCost: totalCost ?? undefined,
          });

          effects.push(() =>
            recordAuditLog({
              action: 'INVENTORY_SALE_DEDUCTED',
              entityType: 'inventory_stock',
              entityId: updated.id,
              actorId: null,
              actorRole: 'system',
              branchId: params.branchId,
              afterState: {
                inventory_item_id: inventoryItemId,
                quantity_change: -quantity,
                quantity_after: updated.quantityOnHand.toNumber(),
                reference_id: params.transactionId,
              },
            }),
          );

          const stockAfter = updated.quantityOnHand.toNumber();
          const lowThreshold = updated.lowStockThreshold?.toNumber() ?? null;
          const criticalThreshold = updated.criticalThreshold?.toNumber() ?? null;
          if (lowThreshold !== null && stockAfter <= lowThreshold) {
            effects.push(() =>
              enqueueRawNotificationJob('low_stock_alert', {
                branchId: params.branchId,
                inventoryItemId,
                ingredientName: itemName,
                currentStock: stockAfter,
                lowStockThreshold: lowThreshold,
                criticalThreshold: criticalThreshold ?? lowThreshold,
                severity: criticalThreshold !== null && stockAfter <= criticalThreshold ? 'critical' : 'low',
              }),
            );
          }
        }

        if (movementInputs.length > 0) {
          await universalInventoryRepository.createStockMovements(movementInputs, tx);
        }

        await inventoryRepository.updateTransactionDeductionStatus(params.transactionId, INVENTORY_DEDUCTION_STATUS.COMPLETED, tx);

        return { applied: true, effects };
      },
      // Same POS-checkout-scoped limits as the old synchronous deduction —
      // a lock/read/update/movement-insert round trip per distinct
      // ingredient can still exceed Prisma's unconfigured defaults.
      { maxWait: 15_000, timeout: 20_000 },
    );
  },

  /**
   * Records a real processing failure. Below INVENTORY_DEDUCTION_MAX_ATTEMPTS
   * the job goes back to `pending` with a bounded backoff (`nextAttemptAt`);
   * at/after the max it goes to `failed` and the Transaction's own
   * inventoryDeductionStatus is flipped to `failed` too, which is what
   * surfaces this through the existing admin pattern (the "critical" badge
   * in view-transaction-detail-dialog.tsx). Guarded on `id + status:
   * 'processing' + claimToken`: an expired owner that lost the row to a
   * reclaim cannot record a failure against the new owner's in-flight claim.
   * `lastError` must already be sanitized by the caller.
   */
  async recordFailure(params: {
    jobId: string;
    transactionId: string;
    claimToken: string;
    attempts: number;
    nextStatus: 'pending' | 'failed';
    lastError: string;
    nextAttemptAt: Date | null;
  }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const guard = await tx.inventoryDeductionJob.updateMany({
        where: { id: params.jobId, status: 'processing', claimToken: params.claimToken },
        data: {
          attempts: params.attempts,
          lastError: params.lastError,
          status: params.nextStatus,
          nextAttemptAt: params.nextAttemptAt,
          claimToken: null,
          lockedAt: null,
        },
      });
      if (guard.count === 0) return;
      if (params.nextStatus === 'failed') {
        await inventoryRepository.updateTransactionDeductionStatus(params.transactionId, INVENTORY_DEDUCTION_STATUS.FAILED, tx);
      }
    });
  },

  /**
   * Void/refund racing a job that hasn't been claimed yet (`pending`) or
   * that already exhausted its retries (`failed`): cancels the job in place
   * and releases the reservation it made at checkout — nothing was ever
   * actually deducted from quantityOnHand for either status, so there is
   * nothing to reverse there, only the reservation to give back. Guarded
   * `updateMany` on `status IN (pending, failed)`: if the job has since
   * moved to `processing` (a worker just claimed it) or `completed` (the
   * worker already finished) between the caller's read and this call,
   * this affects zero rows and returns `false` — the caller must not
   * assume the reservation was released in that case.
   */
  async cancelAndReleaseReservation(tx: Prisma.TransactionClient, jobId: string, branchId: string, transactionId: string): Promise<boolean> {
    const guard = await tx.inventoryDeductionJob.updateMany({
      where: { id: jobId, status: { in: ['pending', 'failed'] } },
      data: { status: 'cancelled', claimToken: null, lockedAt: null },
    });
    if (guard.count === 0) return false;

    const items = await tx.transactionItem.findMany({ where: { transactionId }, select: { deductionSnapshot: true } });
    const totals = totalsFromSnapshots(items);
    for (const [inventoryItemId, { quantity }] of sortedDeductionTotalEntries(totals)) {
      // GREATEST floors at 0 defensively — this release must never drive
      // quantityReserved negative even if it somehow ran twice (it can't,
      // the status guard above only ever flips pending/failed -> cancelled
      // once) or raced a partial release some other way.
      await tx.$executeRaw`
        UPDATE "inventory_stocks"
        SET "quantity_reserved" = GREATEST("quantity_reserved" - ${new Prisma.Decimal(quantity)}, 0), "updated_at" = now()
        WHERE "branch_id" = ${branchId} AND "inventory_item_id" = ${inventoryItemId}
      `;
    }
    return true;
  },

  findJobByTransactionId(transactionId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).inventoryDeductionJob.findUnique({ where: { transactionId } });
  },
};
