import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const recipeInclude = {
  ingredient: { select: { id: true, name: true } },
  flavor: { select: { id: true, name: true } },
} satisfies Prisma.RecipeInclude;

const overrideInclude = {
  ingredient: { select: { id: true, name: true } },
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

  updateRecipe(id: string, data: { quantity?: number; unit?: string }) {
    return prisma.recipe.update({ where: { id }, data, include: recipeInclude });
  },

  /** Soft delete — no hard deletes, matching the architecture's stated principle (previously violated here). */
  deleteRecipe(id: string) {
    return prisma.recipe.update({ where: { id }, data: { deletedAt: new Date() }, include: recipeInclude });
  },

  // --- CR-001 branch overrides ---

  findOverridesByVariantAndBranch(productVariantId: string, branchId: string) {
    return prisma.branchRecipeOverride.findMany({ where: { productVariantId, branchId }, include: overrideInclude });
  },

  findOverrideRows(productVariantId: string, branchId: string, flavorId: string | null) {
    return prisma.branchRecipeOverride.findMany({
      where: { productVariantId, branchId, OR: [{ flavorId: null }, ...(flavorId ? [{ flavorId }] : [])] },
      include: overrideInclude,
    });
  },

  findOverrideById(id: string) {
    return prisma.branchRecipeOverride.findUnique({ where: { id }, include: overrideInclude });
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

  deleteOverride(id: string) {
    return prisma.branchRecipeOverride.delete({ where: { id } });
  },
};
