import { universalInventoryRepository as repo } from './universal-inventory.repository.js';
import { branchesRepository } from '../branches/branches.repository.js';

export interface InventoryStockBackfillReport {
  generatedAt: string;
  dryRun: boolean;
  activeBranches: number;
  activeTrackedItems: number;
  expectedPairs: number;
  existingPairs: number;
  missingPairs: number;
  created: number;
}

/**
 * Branch inventory cutover §13 — safe additive backfill: every active branch
 * × every active, tracked InventoryItem should have exactly one
 * InventoryStock row (quantity 0 if newly created). Never overwrites an
 * existing row's quantity, never deletes anything (legacy or otherwise), and
 * is safe to run multiple times — reuses the same skipDuplicates fan-out
 * primitive as provisionBranchStock/provisionItemAcrossBranches. Read-only
 * when `confirm: false` (the default): reports exactly what a confirmed run
 * would create, without writing anything.
 */
export async function runInventoryStockBackfill(confirm: boolean = false): Promise<InventoryStockBackfillReport> {
  const [branchIds, items] = await Promise.all([branchesRepository.listAllBranchIds(), repo.listActiveTrackedItemIds()]);
  const itemIds = items.map((item) => item.id);
  const expectedPairs = branchIds.length * itemIds.length;

  if (!confirm) {
    const existingPairs = await repo.countExistingStockRows(branchIds, itemIds);
    return {
      generatedAt: new Date().toISOString(),
      dryRun: true,
      activeBranches: branchIds.length,
      activeTrackedItems: itemIds.length,
      expectedPairs,
      existingPairs,
      missingPairs: expectedPairs - existingPairs,
      created: 0,
    };
  }

  const rows = branchIds.flatMap((branchId) => itemIds.map((inventoryItemId) => ({ branchId, inventoryItemId })));
  const result = rows.length > 0 ? await repo.createStockRows(rows) : { count: 0 };
  const existingPairs = expectedPairs - result.count;

  return {
    generatedAt: new Date().toISOString(),
    dryRun: false,
    activeBranches: branchIds.length,
    activeTrackedItems: itemIds.length,
    expectedPairs,
    existingPairs,
    missingPairs: 0,
    created: result.count,
  };
}
