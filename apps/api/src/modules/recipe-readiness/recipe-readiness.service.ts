import { recipeReadinessRepository, type ReadinessVariantRow } from './recipe-readiness.repository.js';
import { READINESS_STATUSES, type ReadinessBlocker, type ReadinessFilters, type ReadinessReport, type ReadinessStatus, type VariantReadiness } from './recipe-readiness.types.js';

function stockKey(branchId: string, inventoryItemId: string): string {
  return `${branchId}::${inventoryItemId}`;
}

/** Priority order when a variant trips more than one rule — the earliest applicable rule becomes the reported `status`; every triggered rule still appears in `blockers`. */
const STATUS_PRIORITY: ReadinessStatus[] = [
  'INACTIVE',
  'NO_RECIPE',
  'INVALID_COMPONENT',
  'UNRESOLVED_MAPPING',
  'INCOMPLETE_BRANCH_STOCK',
  'BACKFILL_CONFLICT',
  'LEGACY_FLAVOR_DEPENDENCY',
];

function isSellableActive(variant: ReadinessVariantRow): boolean {
  return variant.isActive && variant.lifecycleStatus === 'ACTIVE' && variant.product.status === 'active';
}

function branchesWhereProductAvailable(
  variant: ReadinessVariantRow,
  activeBranchIds: string[],
  overridesByBranch: Map<string, boolean>,
): string[] {
  if (variant.product.branchExclusive) {
    return variant.product.exclusiveBranchId && activeBranchIds.includes(variant.product.exclusiveBranchId)
      ? [variant.product.exclusiveBranchId]
      : [];
  }
  return activeBranchIds.filter((branchId) => overridesByBranch.get(branchId) ?? true);
}

function classifyVariant(
  variant: ReadinessVariantRow,
  activeBranchIds: string[],
  overridesByProduct: Map<string, Map<string, boolean>>,
  stockKeys: Set<string>,
  conflictedItemIds: Set<string>,
): VariantReadiness {
  const base = {
    productId: variant.productId,
    productName: variant.product.name,
    productVariantId: variant.id,
    variantName: variant.name,
    sizeLabel: variant.sizeLabel,
  };

  const blockers: ReadinessBlocker[] = [];

  if (!isSellableActive(variant)) {
    blockers.push({ code: 'INACTIVE', message: 'Variant is not active/sellable (variant lifecycle, isActive, or product status).' });
    return { ...base, status: 'INACTIVE', blockers, affectedBranchIds: [], affectedInventoryItemIds: [], availableBranchIds: [] };
  }

  const components = variant.productComponents;

  if (components.length === 0) {
    blockers.push({ code: 'NO_RECIPE', message: 'Variant has no active ProductComponent rows.' });
  }

  const invalidItemIds: string[] = [];
  const seenItemIds = new Set<string>();
  const duplicateItemIds = new Set<string>();
  for (const component of components) {
    if (seenItemIds.has(component.inventoryItemId)) duplicateItemIds.add(component.inventoryItemId);
    seenItemIds.add(component.inventoryItemId);

    const invalid = component.quantityRequired.lessThanOrEqualTo(0) || component.inventoryItem.deletedAt !== null;
    if (invalid) invalidItemIds.push(component.inventoryItemId);
  }
  if (duplicateItemIds.size > 0) invalidItemIds.push(...duplicateItemIds);
  if (invalidItemIds.length > 0) {
    blockers.push({
      code: 'INVALID_COMPONENT',
      message: 'One or more components have an invalid quantity, reference an inactive InventoryItem, or duplicate an active component.',
      inventoryItemIds: Array.from(new Set(invalidItemIds)),
    });
  }

  const unresolvedItemIds = components
    .filter((component) => component.inventoryItem.identityMappings.some((m) => m.mappingStatus === 'PENDING' || m.mappingStatus === 'AMBIGUOUS'))
    .map((component) => component.inventoryItemId);
  if (unresolvedItemIds.length > 0) {
    blockers.push({
      code: 'UNRESOLVED_MAPPING',
      message: 'One or more required InventoryItems have a pending/ambiguous legacy identity mapping.',
      inventoryItemIds: Array.from(new Set(unresolvedItemIds)),
    });
  }

  const overridesByBranch = overridesByProduct.get(variant.productId) ?? new Map<string, boolean>();
  const availableBranchIds = branchesWhereProductAvailable(variant, activeBranchIds, overridesByBranch);
  const missingStockBranchIds = new Set<string>();
  const missingStockItemIds = new Set<string>();
  for (const component of components) {
    for (const branchId of availableBranchIds) {
      if (!stockKeys.has(stockKey(branchId, component.inventoryItemId))) {
        missingStockBranchIds.add(branchId);
        missingStockItemIds.add(component.inventoryItemId);
      }
    }
  }
  if (missingStockBranchIds.size > 0) {
    blockers.push({
      code: 'INCOMPLETE_BRANCH_STOCK',
      message: 'One or more active branches where the product is available are missing an InventoryStock projection row for a required item.',
      branchIds: Array.from(missingStockBranchIds),
      inventoryItemIds: Array.from(missingStockItemIds),
    });
  }

  const conflictedComponentItemIds = components.filter((c) => conflictedItemIds.has(c.inventoryItemId)).map((c) => c.inventoryItemId);
  if (conflictedComponentItemIds.length > 0) {
    blockers.push({
      code: 'BACKFILL_CONFLICT',
      message: 'One or more required InventoryItems have an unresolved (deferred/stuck) projection-outbox conflict.',
      inventoryItemIds: Array.from(new Set(conflictedComponentItemIds)),
    });
  }

  if (variant.productInventory.some((row) => row.flavorId !== null)) {
    blockers.push({
      code: 'LEGACY_FLAVOR_DEPENDENCY',
      message: 'Variant has flavor-specific legacy ProductInventory rows; ProductComponent is flavor-agnostic and cannot represent that consumption yet.',
    });
  }

  const status = STATUS_PRIORITY.find((code) => blockers.some((b) => b.code === code)) ?? 'READY';

  return {
    ...base,
    status,
    blockers,
    affectedBranchIds: Array.from(new Set(blockers.flatMap((b) => b.branchIds ?? []))),
    affectedInventoryItemIds: Array.from(new Set(blockers.flatMap((b) => b.inventoryItemIds ?? []))),
    availableBranchIds,
  };
}

function buildSummary(variants: VariantReadiness[]): ReadinessReport['summary'] {
  const countsByStatus = Object.fromEntries(READINESS_STATUSES.map((s) => [s, 0])) as Record<ReadinessStatus, number>;
  for (const variant of variants) countsByStatus[variant.status] += 1;

  const readyCount = countsByStatus.READY;
  const totalVariants = variants.length;
  const blockedCount = totalVariants - readyCount;

  return {
    totalVariants,
    readyCount,
    blockedCount,
    readinessPercentage: totalVariants === 0 ? 0 : Math.round((readyCount / totalVariants) * 10000) / 100,
    countsByStatus,
  };
}

export const recipeReadinessService = {
  /** Read-only readiness computation. Never writes anything. */
  async buildReport(filters: ReadinessFilters = {}): Promise<ReadinessReport> {
    const [variantRows, activeBranches, stockKeyRows, conflictedItemIds] = await Promise.all([
      recipeReadinessRepository.findVariants({ productId: filters.productId, productVariantId: filters.productVariantId }),
      recipeReadinessRepository.findAllActiveBranches(),
      recipeReadinessRepository.findAllStockKeys(),
      recipeReadinessRepository.findConflictedInventoryItemIds(),
    ]);

    const restrictedBranchIds = filters.accessibleBranchIds === 'all' || filters.accessibleBranchIds === undefined ? null : new Set(filters.accessibleBranchIds);
    const activeBranchIds = activeBranches.map((b) => b.id).filter((id) => !restrictedBranchIds || restrictedBranchIds.has(id));

    const productIds = Array.from(new Set(variantRows.map((v) => v.productId)));
    const availabilityRows = productIds.length > 0 ? await recipeReadinessRepository.findBranchAvailability(productIds) : [];
    const overridesByProduct = new Map<string, Map<string, boolean>>();
    for (const row of availabilityRows) {
      if (!overridesByProduct.has(row.productId)) overridesByProduct.set(row.productId, new Map());
      overridesByProduct.get(row.productId)?.set(row.branchId, row.isAvailable);
    }

    const stockKeys = new Set(stockKeyRows.map((r) => stockKey(r.branchId, r.inventoryItemId)));

    let variants = variantRows.map((variant) => classifyVariant(variant, activeBranchIds, overridesByProduct, stockKeys, conflictedItemIds));

    if (filters.status) variants = variants.filter((v) => v.status === filters.status);
    if (filters.branchId) variants = variants.filter((v) => v.availableBranchIds.includes(filters.branchId as string));

    return { generatedAt: new Date(), summary: buildSummary(variants), variants };
  },
};
