import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductInventoryData, UpdateProductInventoryData } from './product-inventory.types.js';

/** Joined for display in Product Management's business-neutral inventory-mapping UI (Phase 6) — same shape as recipesRepository's ingredient include. flavor is included so the UI can show which mappings are flavor-scoped (flavorId set) vs base (flavorId null). */
const productInventoryInclude = {
  ingredient: { select: { id: true, name: true } },
  flavor: { select: { id: true, name: true } },
} satisfies Prisma.ProductInventoryInclude;

/** Ingredient fields needed for future inventory deduction (quantity math + stock check). Shape aligned with recipesRepository's recipeInclude. */
const productInventoryDeductionInclude = {
  ingredient: { select: { id: true, name: true, branchId: true, unit: true, currentStock: true } },
} satisfies Prisma.ProductInventoryInclude;

/**
 * ProductInventory repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const productInventoryRepository = {
  findByVariant(branchId: string, productVariantId: string) {
    return prisma.productInventory.findMany({
      where: { branchId, productVariantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: productInventoryInclude,
    });
  },

  /**
   * branchIds: 'all' for super_admin, otherwise the caller's allowed branch_ids — a mapping outside that scope resolves to null, same as a missing row.
   * deletedAt: null excludes soft-deleted rows so management update/delete flows treat a soft-deleted mapping as not found.
   */
  findById(id: string, branchIds: string[] | 'all') {
    return prisma.productInventory.findFirst({
      where: { id, deletedAt: null, ...(branchIds !== 'all' && { branchId: { in: branchIds } }) },
      include: productInventoryInclude,
    });
  },

  findByVariantForDeduction(branchId: string, productVariantId: string, flavorId?: string) {
    return prisma.productInventory.findMany({
      where: {
        branchId,
        productVariantId,
        deletedAt: null,
        isActive: true,
        ...(flavorId ? { OR: [{ flavorId: null }, { flavorId }] } : { flavorId: null }),
      },
      include: productInventoryDeductionInclude,
    });
  },

  async hasMappingForVariant(branchId: string, productVariantId: string): Promise<boolean> {
    const count = await prisma.productInventory.count({
      where: { branchId, productVariantId, deletedAt: null, isActive: true },
    });
    return count > 0;
  },

  /**
   * Branch-agnostic counterpart to hasMappingForVariant — Product approval is
   * a global gate (a variant can go ACTIVE without being scoped to any one
   * branch), so it must not require a mapping in a specific branchId.
   */
  async hasAnyActiveMappingForVariant(productVariantId: string): Promise<boolean> {
    const count = await prisma.productInventory.count({
      where: { productVariantId, deletedAt: null, isActive: true },
    });
    return count > 0;
  },

  /** Ingredient ownership check for create — scoped by branchId in the same query so an ingredient belonging to another branch resolves to null, same as a missing ingredient. */
  findIngredientForBranch(ingredientId: string, branchId: string) {
    return prisma.ingredient.findFirst({ where: { id: ingredientId, branchId, deletedAt: null } });
  },

  findByVariantAndIngredient(branchId: string, productVariantId: string, ingredientId: string, flavorId: string | null = null) {
    // Prisma's compound-unique findUnique input requires flavorId: string (not
    // string | null) even though the column is nullable, so a null default
    // can't go through findUnique here — findFirst accepts null in `where`
    // and still resolves to at most one row given the @@unique constraint.
    // deletedAt: null excludes soft-deleted rows (the partial unique index
    // permits reuse only after soft deletion); isActive is deliberately not
    // filtered here so an inactive-but-not-deleted row still counts as a
    // duplicate.
    return prisma.productInventory.findFirst({
      where: { branchId, productVariantId, ingredientId, flavorId, deletedAt: null },
    });
  },

  create(data: CreateProductInventoryData & { branchId: string }) {
    return prisma.productInventory.create({
      data: {
        branchId: data.branchId,
        productVariantId: data.productVariantId,
        ingredientId: data.ingredientId,
        flavorId: data.flavorId ?? null,
        quantityRequired: data.quantityRequired,
        unit: data.unit,
      },
      include: productInventoryInclude,
    });
  },

  /** Existence check for create — a flavor_id that doesn't resolve to a real Flavor row must not pass through to the FK insert as an opaque P2003 failure. */
  findFlavorById(flavorId: string) {
    return prisma.flavor.findUnique({ where: { id: flavorId }, select: { id: true, name: true } });
  },

  /**
   * PRODUCT_INVENTORY_FLAVOR_NOT_LINKED gate (Phase 5) — a flavor-specific
   * mapping may only be created for a flavor actively linked to this variant
   * (ProductVariantFlavor.isAvailable) and itself active. Returns null when
   * no such link exists, which the service treats as a rejection.
   */
  findActiveVariantFlavorLink(productVariantId: string, flavorId: string) {
    return prisma.productVariantFlavor.findFirst({
      where: { productVariantId, flavorId, isAvailable: true, flavor: { isActive: true } },
    });
  },

  /**
   * Live POS readiness (Phase 1) — every active, non-deleted ProductInventory
   * mapping for this branch across the given variants in one query, avoiding
   * an N+1 per variant. The service partitions the result into base
   * (flavorId null) vs flavor-scoped mappings per variant.
   */
  findActiveMappingsForVariants(branchId: string, productVariantIds: string[]) {
    return prisma.productInventory.findMany({
      where: { branchId, productVariantId: { in: productVariantIds }, deletedAt: null, isActive: true },
      select: { productVariantId: true, flavorId: true },
    });
  },

  /**
   * updateMany (not update) so the WHERE clause itself enforces branch scope
   * at the write — a mapping outside branchIds resolves to `count: 0` rather
   * than a Prisma "record not found" throw, and can never be written to
   * regardless of what a prior service-level check found. deletedAt: null
   * ensures a soft-deleted row can never be written to even if a caller races
   * the findById check above.
   */
  update(id: string, data: UpdateProductInventoryData, branchIds: string[] | 'all') {
    return prisma.productInventory.updateMany({
      where: { id, deletedAt: null, ...(branchIds !== 'all' && { branchId: { in: branchIds } }) },
      data: {
        ...(data.quantityRequired !== undefined && { quantityRequired: data.quantityRequired }),
        ...(data.unit !== undefined && { unit: data.unit }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        version: { increment: 1 },
      },
    });
  },

  /**
   * Soft delete — updateMany (not update) for the same branch-scoped-write
   * reason as update above, plus deletedAt: null in the WHERE clause so an
   * already-deleted row can never be soft-deleted again (resolves to
   * `count: 0`, same as an out-of-scope row).
   */
  delete(id: string, branchIds: string[] | 'all', updatedBy: string) {
    return prisma.productInventory.updateMany({
      where: { id, deletedAt: null, ...(branchIds !== 'all' && { branchId: { in: branchIds } }) },
      data: { deletedAt: new Date(), isActive: false, updatedBy },
    });
  },

  /**
   * MAX(version) across the active ProductInventory mappings that participate
   * in deduction for this branch/variant/flavor — same base+flavor-specific
   * selection as findByVariantForDeduction, scoped to the branch via
   * ingredient.branchId. Defaults to 1 when there are no mappings yet.
   */
  async getVersionForVariant(branchId: string, productVariantId: string, flavorId?: string): Promise<number> {
    const rows = await prisma.productInventory.findMany({
      where: {
        productVariantId,
        ingredient: { branchId },
        ...(flavorId ? { OR: [{ flavorId: null }, { flavorId }] } : { flavorId: null }),
      },
      select: { version: true },
    });
    if (rows.length === 0) return 1;
    return Math.max(...rows.map((r) => r.version));
  },

  /**
   * Every distinct (name, unit) ingredient identity referenced by a
   * ProductInventory mapping, deduped by name — mirrors
   * recipesRepository.findDistinctIngredientIdentities, but sourced from
   * ProductInventory since that's computeDeduction's actual data source
   * (see recipes.service.ts computeDeduction / findByVariantForDeduction).
   */
  async findDistinctIngredientIdentities(tx?: Prisma.TransactionClient): Promise<{ name: string; unit: string }[]> {
    const client = tx ?? prisma;
    const rows = await client.productInventory.findMany({
      select: { ingredient: { select: { name: true, unit: true } } },
      distinct: ['ingredientId'],
    });
    const byName = new Map<string, { name: string; unit: string }>();
    for (const row of rows) {
      if (!byName.has(row.ingredient.name)) byName.set(row.ingredient.name, row.ingredient);
    }
    return [...byName.values()];
  },

  /**
   * ProductInventory rows referencing this ingredient — the out-of-stock
   * cascade's (§7.2) equivalent of the old Recipe + BranchRecipeOverride
   * union. ProductInventory carries no branch column of its own: each
   * Ingredient row is already branch-scoped (CR-004 provisioning creates one
   * per branch), so a plain ingredientId filter covers what previously
   * needed a master-table + branch-override union.
   */
  findByIngredientId(ingredientId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.productInventory.findMany({
      where: { ingredientId },
      select: { productVariantId: true, flavorId: true },
    });
  },
};
