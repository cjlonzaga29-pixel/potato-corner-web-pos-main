import { prisma } from '../../lib/prisma.js';

export const productComponentsBackfillRepository = {
  /** Count of every active, non-deleted ProductInventory row, flavor-specific or not — used only to size the "excluded flavor-specific" report line. */
  countActiveProductInventoryRows() {
    return prisma.productInventory.count({ where: { deletedAt: null, isActive: true } });
  },

  /**
   * Eligible legacy source set: active, non-deleted, and NOT flavor-specific
   * (flavorId: null). ProductComponent has no flavor-aware column, so a
   * flavor-specific ProductInventory row can't be safely represented here
   * (rule: exclude flavor-specific mappings unless ProductComponent already
   * supports flavor-aware components — it doesn't).
   */
  fetchEligibleProductInventoryRows() {
    return prisma.productInventory.findMany({
      where: { deletedAt: null, isActive: true, flavorId: null },
      select: {
        id: true,
        productVariantId: true,
        ingredientId: true,
        quantityRequired: true,
        unit: true,
        ingredient: { select: { name: true } },
      },
    });
  },

  /**
   * Every InventoryIdentityMapping row for the given legacy ingredient ids —
   * covers PENDING/AMBIGUOUS/REJECTED rows too, since the unresolved-mapping
   * report needs to explain *why* an ingredient has no usable mapping, not
   * just that it's missing one.
   */
  fetchIdentityMappingsForIngredients(legacyIngredientIds: string[]) {
    if (legacyIngredientIds.length === 0) return Promise.resolve([]);
    return prisma.inventoryIdentityMapping.findMany({
      where: { legacyIngredientId: { in: legacyIngredientIds } },
      select: { legacyIngredientId: true, inventoryItemId: true, mappingStatus: true, mappingMethod: true },
    });
  },

  /** Base unit codes for the resolved InventoryItems a candidate pair targets — used to detect a legacy unit that doesn't match the item's base unit (unsafe to copy without conversion). */
  fetchInventoryItemBaseUnits(inventoryItemIds: string[]) {
    if (inventoryItemIds.length === 0) return Promise.resolve([]);
    return prisma.inventoryItem.findMany({
      where: { id: { in: inventoryItemIds }, deletedAt: null },
      select: { id: true, baseUnit: { select: { code: true } } },
    });
  },

  /** Any-state (active or soft-deleted) existing ProductComponent for a pair — lets the backfill distinguish "never created", "already backfilled" (idempotent skip), and "manually created" (never overwrite). */
  findExistingComponent(productVariantId: string, inventoryItemId: string) {
    return prisma.productComponent.findFirst({
      where: { productVariantId, inventoryItemId },
      select: { id: true, createdBy: true, deletedAt: true },
    });
  },
};
