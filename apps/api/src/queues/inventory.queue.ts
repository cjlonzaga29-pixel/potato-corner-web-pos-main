import { Queue, Worker, type Job } from 'bullmq';
import { MOVEMENT_TYPE, INVENTORY_DEDUCTION_STATUS, SOCKET_EVENTS } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { inventoryRepository } from '../modules/inventory/inventory.repository.js';
import { computeDeduction } from '../modules/recipes/recipes.service.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { notificationQueue } from './notification.queue.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';

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

export const inventoryQueue = new Queue('inventory', { connection: redis });

/** Architecture doc §3.6: 10s / 60s / 300s backoff, one delay per retry attempt. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

/**
 * Enqueues Phase 8's post-sale deduction job. jobId = transactionId, so
 * re-enqueuing the same transaction (e.g. a caller retrying after a
 * timeout) is a no-op against the already-queued/processed job — this is
 * the worker's idempotency guarantee, enforced by BullMQ itself rather
 * than application-level dedup logic.
 */
export function enqueueSaleDeduction(data: SaleDeductionJobData): Promise<Job> {
  return inventoryQueue.add('sale_deduction', data, {
    jobId: data.transactionId,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'custom' },
  });
}

export async function processSaleDeduction(job: Job<SaleDeductionJobData>): Promise<void> {
  const { transactionId, branchId, items } = job.data;

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
      await notificationQueue.add('low_stock_alert', {
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
        await notificationQueue.add('inventory_product_unavailable', cascadePayload);
      }
    }
  }

  await inventoryRepository.updateTransactionDeductionStatus(transactionId, INVENTORY_DEDUCTION_STATUS.COMPLETED);
}

/**
 * Inventory queue worker. Phase 8 wires up the one job type it needs
 * (sale_deduction) per the architecture spec's retry policy (10s, 60s, 300s
 * backoff; see Architecture doc §3.6 for the per-queue behavior).
 */
export const inventoryWorker = new Worker(
  'inventory',
  async (job: Job) => {
    if (job.name === 'sale_deduction') {
      await processSaleDeduction(job as Job<SaleDeductionJobData>);
      return;
    }
    // TODO(Phase 8+): implement remaining inventory job types.
  },
  {
    connection: createWorkerConnection(),
    settings: {
      backoffStrategy: retryDelayMs,
    },
  },
);

/**
 * After the 3rd failed attempt, mark the transaction's deduction as failed
 * (Architecture doc §3.6: "after 3 failures mark deduction failed, notify
 * supervisor") instead of leaving it stuck at `pending` forever.
 */
inventoryWorker.on('failed', (job, error) => {
  if (!job || job.name !== 'sale_deduction') return;
  if (job.attemptsMade < (job.opts.attempts ?? MAX_ATTEMPTS)) return;

  const { transactionId, branchId } = job.data as SaleDeductionJobData;
  console.error(`Inventory deduction permanently failed for transaction ${transactionId}:`, error.message);

  void inventoryRepository.updateTransactionDeductionStatus(transactionId, INVENTORY_DEDUCTION_STATUS.FAILED);
  void recordAuditLog({
    action: 'INVENTORY_SALE_DEDUCTION_FAILED',
    entityType: 'transaction',
    entityId: transactionId,
    actorId: null,
    actorRole: 'system',
    branchId,
    afterState: { transaction_id: transactionId, error: error.message, attempts: job.attemptsMade },
  });
  void notificationQueue.add('inventory_deduction_failed', { transactionId, branchId, error: error.message });
});
