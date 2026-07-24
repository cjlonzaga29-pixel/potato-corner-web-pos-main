import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const recipeInclude = {
  // branchId is needed by recipes.service.ts computeDeduction to tell
  // whether a master row's own Ingredient already belongs to the selling
  // branch, or needs CR-004 cross-branch resolution.
  ingredient: { select: { id: true, name: true, branchId: true } },
  flavor: { select: { id: true, name: true } },
} satisfies Prisma.RecipeInclude;

const overrideInclude = {
  ingredient: { select: { id: true, name: true, branchId: true } },
  flavor: { select: { id: true, name: true } },
} satisfies Prisma.BranchRecipeOverrideInclude;

/**
 * Recipes repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly. Owns both the
 * master Recipe table (Phase 7 foundation) and the CR-001
 * BranchRecipeOverride table.
 */
export const recipesRepository = {
  findByVariant(productVariantId: string) {
    return prisma.recipe.findMany({ where: { productVariantId, deletedAt: null }, include: recipeInclude });
  },

  /** Architecture doc §7.1 steps 1-2, both fetched together: base rows plus this specific flavor's rows (if any). */
  findMasterRows(productVariantId: string, flavorId: string | null) {
    return prisma.recipe.findMany({
      where: { productVariantId, deletedAt: null, OR: [{ flavorId: null }, ...(flavorId ? [{ flavorId }] : [])] },
      include: recipeInclude,
    });
  },

  findRecipeById(id: string) {
    return prisma.recipe.findFirst({ where: { id, deletedAt: null }, include: recipeInclude });
  },

  createRecipe(data: { productVariantId: string; ingredientId: string; flavorId: string | null; quantity: number; unit: string }) {
    return prisma.recipe.create({
      data: {
        productVariantId: data.productVariantId,
        ingredientId: data.ingredientId,
        flavorId: data.flavorId,
        quantity: data.quantity,
        unit: data.unit,
      },
      include: recipeInclude,
    });
  },

  /** CR-004: every update bumps `version` — the field TransactionItem.recipeVersion snapshots at sale time. */
  updateRecipe(id: string, data: { quantity?: number; unit?: string }) {
    return prisma.recipe.update({ where: { id }, data: { ...data, version: { increment: 1 } }, include: recipeInclude });
  },

  /** Soft delete — no hard deletes, matching the architecture's stated principle (previously violated here). */
  deleteRecipe(id: string) {
    return prisma.recipe.update({ where: { id }, data: { deletedAt: new Date() }, include: recipeInclude });
  },

  // --- CR-001 branch overrides ---

  findOverridesByVariantAndBranch(productVariantId: string, branchId: string) {
    return prisma.branchRecipeOverride.findMany({
      where: { productVariantId, branchId, deletedAt: null },
      include: overrideInclude,
    });
  },

  findOverrideRows(productVariantId: string, branchId: string, flavorId: string | null) {
    return prisma.branchRecipeOverride.findMany({
      where: { productVariantId, branchId, deletedAt: null, OR: [{ flavorId: null }, ...(flavorId ? [{ flavorId }] : [])] },
      include: overrideInclude,
    });
  },

  findOverrideById(id: string) {
    return prisma.branchRecipeOverride.findFirst({ where: { id, deletedAt: null }, include: overrideInclude });
  },

  createOverride(data: {
    branchId: string;
    productVariantId: string;
    ingredientId: string;
    flavorId: string | null;
    quantity: number;
    unit: string;
    reason: string;
    createdBy: string;
  }) {
    return prisma.branchRecipeOverride.create({ data, include: overrideInclude });
  },

  updateOverride(id: string, data: { quantity?: number; unit?: string; reason: string }) {
    return prisma.branchRecipeOverride.update({ where: { id }, data, include: overrideInclude });
  },

  /** Soft delete — no hard deletes, matching the architecture's stated principle (previously violated here). */
  deleteOverride(id: string) {
    return prisma.branchRecipeOverride.update({ where: { id }, data: { deletedAt: new Date() }, include: overrideInclude });
  },

  // --- CR-004 ---

  /** Used by transactions.service.ts to reject a sale for a variant with no master recipe configured at all. */
  async hasActiveRecipeForVariant(productVariantId: string): Promise<boolean> {
    const count = await prisma.recipe.count({ where: { productVariantId, deletedAt: null } });
    return count > 0;
  },

  /**
   * The highest `version` among the master rows that apply to this
   * variant+flavor selection (base rows plus this specific flavor's rows, if
   * any — same set computeDeduction's masterRows covers). Snapshotted onto
   * TransactionItem.recipeVersion. Defaults to 1 when the variant has no
   * master rows yet (guarded against separately by hasActiveRecipeForVariant).
   */
  async getMaxVersionForSelection(productVariantId: string, flavorId: string | null): Promise<number> {
    const rows = await prisma.recipe.findMany({
      where: { productVariantId, deletedAt: null, OR: [{ flavorId: null }, ...(flavorId ? [{ flavorId }] : [])] },
      select: { version: true },
    });
    if (rows.length === 0) return 1;
    return Math.max(...rows.map((r) => r.version));
  },

  /**
   * Every distinct (name, unit) ingredient identity referenced by an active
   * master recipe row, deduped by name — the set a newly created branch
   * needs a zero-stock Ingredient row for (branchesService.createBranch ->
   * inventoryService.provisionBranchIngredients).
   */
  async findDistinctIngredientIdentities(): Promise<{ name: string; unit: string }[]> {
    const rows = await prisma.recipe.findMany({
      where: { deletedAt: null },
      select: { ingredient: { select: { name: true, unit: true } } },
      distinct: ['ingredientId'],
    });
    const byName = new Map<string, { name: string; unit: string }>();
    for (const row of rows) {
      if (!byName.has(row.ingredient.name)) byName.set(row.ingredient.name, row.ingredient);
    }
    return [...byName.values()];
  },
};
