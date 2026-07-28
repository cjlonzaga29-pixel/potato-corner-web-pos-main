import { Prisma } from '@prisma/client';
import { inventoryReconciliationRepository } from './inventory-reconciliation.repository.js';
import {
  unprocessedOutboxCount,
  type DriftEntry,
  type MatchedEntry,
  type MissingStockEntry,
  type OrphanStockEntry,
  type ProjectionKey,
  type ReconciliationReport,
  type RebuildPlan,
  type RebuildPlanRow,
  type RebuildResult,
  type UnresolvedMappingEntry,
} from './inventory-reconciliation.types.js';

function key(k: ProjectionKey): string {
  return `${k.branchId}::${k.inventoryItemId}`;
}

interface ExpectedGroup extends ProjectionKey {
  legacyIngredientIds: string[];
  expectedQuantity: Prisma.Decimal;
  movementCutoff: Date;
}

/**
 * The core derivation: InventoryMovement (source of truth) -> accepted
 * InventoryIdentityMapping rows -> expected InventoryStock per
 * (branchId, inventoryItemId). Multiple legacy ingredients may map to the
 * same inventoryItemId (no unique constraint on that column), so their
 * movement sums are combined into one expected quantity.
 */
async function computeExpectedGroups(): Promise<Map<string, ExpectedGroup>> {
  const accepted = await inventoryReconciliationRepository.findAcceptedMappings();
  const groups = new Map<string, ExpectedGroup>();
  for (const mapping of accepted) {
    const k = key(mapping);
    const existing = groups.get(k);
    if (existing) {
      existing.legacyIngredientIds.push(mapping.legacyIngredientId);
    } else {
      groups.set(k, {
        branchId: mapping.branchId,
        inventoryItemId: mapping.inventoryItemId,
        legacyIngredientIds: [mapping.legacyIngredientId],
        expectedQuantity: new Prisma.Decimal(0),
        movementCutoff: new Date(0),
      });
    }
  }

  const allIngredientIds = accepted.map((row) => row.legacyIngredientId);
  const aggregates = await inventoryReconciliationRepository.aggregateMovementsByIngredient(allIngredientIds);

  for (const group of groups.values()) {
    let sum = new Prisma.Decimal(0);
    let cutoff = new Date(0);
    for (const ingredientId of group.legacyIngredientIds) {
      const aggregate = aggregates.get(ingredientId);
      if (!aggregate) continue;
      sum = sum.plus(aggregate.sum);
      if (aggregate.maxCreatedAt > cutoff) cutoff = aggregate.maxCreatedAt;
    }
    group.expectedQuantity = sum;
    // No movement ever recorded for any mapped ingredient in this group: use
    // "now" as the cutoff so a movement created moments from now is still
    // treated as newer than the rebuild, never accidentally suppressed.
    group.movementCutoff = cutoff.getTime() === 0 ? new Date() : cutoff;
  }

  return groups;
}

async function computeUnresolvedMappings(acceptedIngredientIds: Set<string>): Promise<UnresolvedMappingEntry[]> {
  const ingredientsWithMovements = await inventoryReconciliationRepository.findIngredientsWithMovements();
  const candidates = ingredientsWithMovements.filter((ingredient) => !acceptedIngredientIds.has(ingredient.id));
  if (candidates.length === 0) return [];

  const statusByIngredientId = await inventoryReconciliationRepository.findUnacceptedMappingsByIngredientIds(candidates.map((c) => c.id));

  const reasonFor = (status: string | undefined): UnresolvedMappingEntry['reason'] => {
    switch (status) {
      case 'PENDING':
        return 'pending';
      case 'AMBIGUOUS':
        return 'ambiguous';
      case 'REJECTED':
        return 'rejected';
      default:
        return 'no_mapping';
    }
  };

  return candidates.map((ingredient) => ({
    branchId: ingredient.branchId,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    reason: reasonFor(statusByIngredientId.get(ingredient.id)),
  }));
}

export const inventoryReconciliationService = {
  /** Read-only comparison report. Never writes anything. */
  async buildReport(): Promise<ReconciliationReport> {
    const groups = await computeExpectedGroups();
    const stockRows = await inventoryReconciliationRepository.findAllStockRows();
    const stockByKey = new Map(stockRows.map((row) => [key(row), row]));

    const matched: MatchedEntry[] = [];
    const missingStock: MissingStockEntry[] = [];
    const drift: DriftEntry[] = [];

    for (const group of groups.values()) {
      const stock = stockByKey.get(key(group));
      if (!stock) {
        missingStock.push({
          branchId: group.branchId,
          inventoryItemId: group.inventoryItemId,
          legacyIngredientIds: group.legacyIngredientIds,
          expectedQuantity: group.expectedQuantity,
        });
        continue;
      }
      if (stock.quantityOnHand.equals(group.expectedQuantity)) {
        matched.push({
          branchId: group.branchId,
          inventoryItemId: group.inventoryItemId,
          legacyIngredientIds: group.legacyIngredientIds,
          quantity: stock.quantityOnHand,
        });
      } else {
        drift.push({
          branchId: group.branchId,
          inventoryItemId: group.inventoryItemId,
          legacyIngredientIds: group.legacyIngredientIds,
          expectedQuantity: group.expectedQuantity,
          actualQuantity: stock.quantityOnHand,
          drift: stock.quantityOnHand.minus(group.expectedQuantity),
        });
      }
    }

    const orphanStock: OrphanStockEntry[] = stockRows
      .filter((row) => !groups.has(key(row)))
      .map((row) => ({ branchId: row.branchId, inventoryItemId: row.inventoryItemId, quantityOnHand: row.quantityOnHand }));

    const acceptedIngredientIds = new Set(Array.from(groups.values()).flatMap((g) => g.legacyIngredientIds));
    const unresolvedMapping = await computeUnresolvedMappings(acceptedIngredientIds);

    return { matched, missingStock, drift, unresolvedMapping, orphanStock };
  },

  /** Computes what a rebuild would do, without writing. Always safe to run. */
  async buildRebuildPlan(): Promise<RebuildPlan> {
    const groups = await computeExpectedGroups();
    const stockRows = await inventoryReconciliationRepository.findAllStockRows();
    const stockByKey = new Map(stockRows.map((row) => [key(row), row]));

    const rows: RebuildPlanRow[] = [];
    for (const group of groups.values()) {
      const stock = stockByKey.get(key(group));
      const action: RebuildPlanRow['action'] = !stock ? 'create' : stock.quantityOnHand.equals(group.expectedQuantity) ? 'unchanged' : 'update';
      rows.push({
        branchId: group.branchId,
        inventoryItemId: group.inventoryItemId,
        legacyIngredientIds: group.legacyIngredientIds,
        expectedQuantity: group.expectedQuantity,
        currentQuantity: stock?.quantityOnHand ?? null,
        currentVersion: stock?.version ?? null,
        action,
        movementCutoff: group.movementCutoff,
      });
    }

    const orphans: OrphanStockEntry[] = stockRows
      .filter((row) => !groups.has(key(row)))
      .map((row) => ({ branchId: row.branchId, inventoryItemId: row.inventoryItemId, quantityOnHand: row.quantityOnHand }));

    const outboxCounts = await inventoryReconciliationRepository.getOutboxStatusCounts();
    const rebuildCutoff = rows.reduce((max, row) => (row.movementCutoff > max ? row.movementCutoff : max), new Date(0));

    return { rows, orphans, outboxCounts, rebuildCutoff: rebuildCutoff.getTime() === 0 ? new Date() : rebuildCutoff };
  },

  /**
   * Applies a rebuild plan. Requires `confirm: true` — this is the only
   * function in this module that writes, and it only ever touches
   * InventoryStock (never Ingredient, ProductInventory, InventoryMovement,
   * or the outbox). Blocked by unprocessed outbox rows unless
   * `allowPendingOutbox` is explicitly set. Orphan rows are reported and
   * left alone unless `deleteOrphans` is explicitly set.
   */
  async executeRebuild(options: { confirm: boolean; allowPendingOutbox?: boolean; deleteOrphans?: boolean }): Promise<RebuildResult> {
    if (!options.confirm) {
      throw new Error('Rebuild requires confirm: true. Run buildRebuildPlan() (dry-run) first and review it.');
    }

    const plan = await this.buildRebuildPlan();
    const unprocessed = unprocessedOutboxCount(plan.outboxCounts);
    if (unprocessed > 0 && !options.allowPendingOutbox) {
      throw new Error(
        `Refusing to rebuild: ${unprocessed} unprocessed InventoryProjectionOutbox row(s) ` +
          `(pending=${plan.outboxCounts.pending}, processing=${plan.outboxCounts.processing}, ` +
          `deferred=${plan.outboxCounts.deferred}, stuck=${plan.outboxCounts.stuck}). ` +
          'Disable the projection worker or pass allowPendingOutbox: true to proceed anyway.',
      );
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let orphansDeleted = 0;

    await inventoryReconciliationRepository.runInTransaction(async (tx) => {
      for (const row of plan.rows) {
        await inventoryReconciliationRepository.upsertStockRow(
          {
            branchId: row.branchId,
            inventoryItemId: row.inventoryItemId,
            expectedQuantity: row.expectedQuantity,
            action: row.action,
            rebuiltThroughAt: row.movementCutoff,
          },
          tx,
        );
        if (row.action === 'create') created += 1;
        else if (row.action === 'update') updated += 1;
        else unchanged += 1;
      }

      if (options.deleteOrphans) {
        for (const orphan of plan.orphans) {
          await inventoryReconciliationRepository.deleteOrphan(orphan.branchId, orphan.inventoryItemId, tx);
          orphansDeleted += 1;
        }
      }
    });

    return { ...plan, created, updated, unchanged, orphansDeleted, applied: true };
  },
};
