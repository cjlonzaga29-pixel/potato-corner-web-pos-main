import { MOVEMENT_TYPE, INVENTORY_DEDUCTION_STATUS, SOCKET_EVENTS } from '@potato-corner/shared';
import { runFireAndForget, runWithRetry } from '../lib/job-runner.js';
import { hashToLockId } from '../lib/pg-lock.js';
import { sha256Hex } from '../lib/hash.js';
import { inventoryRepository } from '../modules/inventory/inventory.repository.js';
import { computeDeduction } from '../modules/recipes/recipes.service.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { enqueueRawNotificationJob } from './notification.queue.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';
import { prisma } from '../lib/prisma.js';

export interface SaleDeductionItem {
  productVariantId: string;
  flavorId: string | null;
  quantity: number;
}

export interface SaleDeductionJobData {
  transactionId: string;
  branchId: string;
  items: SaleDeductionItem[];
}

/**
 * Phase 21: BullMQ removed — see lib/job-runner.ts. RETRY_DELAYS_MS below
 * preserves Architecture doc §3.6's 10s/60s/300s backoff. BullMQ's
 * `jobId: transactionId` used to also dedupe concurrent enqueues of the
 * same transaction at the queue level; a Postgres advisory lock keyed by
 * transactionId (see refreshToken's use of the same pattern in
 * auth.service.ts) now serializes concurrent processSaleDeduction calls for
 * the same transaction instead — hasMovementForReference's per-ingredient
 * check below is what actually makes a re-run a no-op, the lock just
 * prevents two concurrent runs from both passing that check before either
 * has written.
 */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * Enqueues Phase 8's post-sale deduction job. Runs in the background;
 * returns immediately (matching the old queue.add()'s "enqueued, not yet
 * processed" semantics) with retry/backoff preserved via runWithRetry. On
 * final failure, notifies the same way BullMQ's `worker.on('failed', ...)`
 * used to (see the end of this file).
 */
export function enqueueSaleDeduction(data: SaleDeductionJobData): Promise<void> {
  runFireAndForget(
    () => runWithRetry((attempt) => processSaleDeductionWithLock(data, attempt), RETRY_DELAYS_MS),
    (error) => handleSaleDeductionFailure(data, error, MAX_ATTEMPTS),
  );
  return Promise.resolve();
}

async function processSaleDeductionWithLock(data: SaleDeductionJobData, attempt: number): Promise<void> {
  const lockId = hashToLockId(sha256Hex(data.transactionId));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
    await processSaleDeduction(data);
  });
  void attempt;
}

export async function processSaleDeduction(job: SaleDeductionJobData): Promise<void> {
  const { transactionId, branchId, items } = job;

  // Aggregate every item's deduction lines by ingredient first, so a
  // transaction with multiple products sharing an ingredient produces one
  // ledger row per ingredient instead of one per product line.
  const totals = new Map<string, { quantity: number; ingredientName: string }>();
  for (const item of items) {
    const lines = await computeDeduction({
      productVariantId: item.productVariantId,
      flavorId: item.flavorId,
      quantitySold: item.quantity,
      branchId,
    });
    if (lines.length === 0) {
      console.warn(
        `No recipe found for product variant ${item.productVariantId} (flavor ${item.flavorId ?? 'none'}) — skipping this line item, transaction ${transactionId}`,
      );
      continue;
    }
    for (const line of lines) {
      const existing = totals.get(line.ingredient_id);
      totals.set(line.ingredient_id, {
        quantity: (existing?.quantity ?? 0) + line.quantity,
        ingredientName: line.ingredient_name,
      });
    }
  }

  for (const [ingredientId, total] of totals) {
    // A retried job (after a partial failure on an earlier attempt) must
    // not re-append a movement for an ingredient it already recorded —
    // only the ingredients it didn't reach should be (re-)processed.
    const alreadyRecorded = await inventoryRepository.hasMovementForReference(ingredientId, transactionId, MOVEMENT_TYPE.SALE_DEDUCTION);
    if (alreadyRecorded) continue;

    const ingredient = await inventoryRepository.findIngredientById(ingredientId);
    // Ingredient soft-deleted since the recipe was defined — nothing left to deduct against.
    if (!ingredient) continue;

    const movement = await inventoryRepository.appendMovement({
      branchId,
      ingredientId,
      movementType: MOVEMENT_TYPE.SALE_DEDUCTION,
      quantityChange: -total.quantity,
      referenceId: transactionId,
      notes: `Sale deduction for transaction ${transactionId}`,
    });

    await recordAuditLog({
      action: 'INVENTORY_SALE_DEDUCTED',
      entityType: 'inventory_movement',
      entityId: movement.id,
      actorId: null,
      actorRole: 'system',
      branchId,
      afterState: {
        ingredient_id: ingredientId,
        quantity_change: movement.quantityChange.toNumber(),
        quantity_after: movement.quantityAfter.toNumber(),
        reference_id: transactionId,
      },
    });

    const currentStock = movement.quantityAfter.toNumber();
    const lowThreshold = ingredient.lowStockThreshold.toNumber();
    const criticalThreshold = ingredient.criticalThreshold.toNumber();
    if (currentStock <= lowThreshold) {
      await enqueueRawNotificationJob('low_stock_alert', {
        branchId,
        ingredientId,
        ingredientName: total.ingredientName,
        currentStock,
        lowStockThreshold: lowThreshold,
        criticalThreshold,
        severity: currentStock <= criticalThreshold ? 'critical' : 'low',
      });
    }

    // Architecture doc §7.2 Out-of-Stock Cascade — only once stock has
    // actually reached zero (or gone negative from a concurrent deduction),
    // never merely low/critical.
    if (currentStock <= 0) {
      const cascadeResult = await inventoryRepository.runOutOfStockCascade(branchId, ingredientId);
      console.warn(
        `Out-of-stock cascade for ingredient ${ingredientId} (${total.ingredientName}) at branch ${branchId}: ${cascadeResult.affectedFlavors.length} flavor(s), ${cascadeResult.affectedProducts.length} product(s) newly unavailable`,
      );
      if (cascadeResult.affectedFlavors.length > 0 || cascadeResult.affectedProducts.length > 0) {
        const cascadePayload = {
          branchId,
          triggeredByIngredientId: ingredientId,
          triggeredByIngredientName: total.ingredientName,
          affectedFlavors: cascadeResult.affectedFlavors.map((f) => ({ flavorId: f.flavorId, name: f.flavorName })),
          affectedProducts: cascadeResult.affectedProducts.map((p) => ({ productId: p.productId, name: p.productName })),
        };
        notifyBranch(branchId, SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE, cascadePayload);
        notifySuperAdmin(SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE, cascadePayload);
        await enqueueRawNotificationJob('inventory_product_unavailable', cascadePayload);
      }
    }
  }

  await inventoryRepository.updateTransactionDeductionStatus(transactionId, INVENTORY_DEDUCTION_STATUS.COMPLETED);
}

/**
 * After the final retry attempt, mark the transaction's deduction as failed
 * (Architecture doc §3.6: "after 3 failures mark deduction failed, notify
 * supervisor") instead of leaving it stuck at `pending` forever. Mirrors
 * the old inventoryWorker.on('failed', ...) handler.
 */
function handleSaleDeductionFailure(data: SaleDeductionJobData, error: unknown, attemptsMade: number): void {
  const { transactionId, branchId } = data;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Inventory deduction permanently failed for transaction ${transactionId}:`, message);

  void inventoryRepository.updateTransactionDeductionStatus(transactionId, INVENTORY_DEDUCTION_STATUS.FAILED);
  void recordAuditLog({
    action: 'INVENTORY_SALE_DEDUCTION_FAILED',
    entityType: 'transaction',
    entityId: transactionId,
    actorId: null,
    actorRole: 'system',
    branchId,
    afterState: { transaction_id: transactionId, error: message, attempts: attemptsMade },
  });
  void enqueueRawNotificationJob('inventory_deduction_failed', { transactionId, branchId, error: message });
}
