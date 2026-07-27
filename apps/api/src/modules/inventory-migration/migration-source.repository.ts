import { prisma } from '../../lib/prisma.js';
import type { LegacyIngredientRecord, LegacyFlavorRecord, SourceSummary } from './types.js';

/**
 * Read-only queries against legacy inventory sources for CR-006 Phase B
 * analysis. No method here writes — Phase B performs zero database writes
 * (CR-007 SS20, "REQUIRED WORK" item 8).
 */

export async function fetchLegacyIngredients(): Promise<LegacyIngredientRecord[]> {
  return prisma.ingredient.findMany({
    select: { id: true, name: true, unit: true, category: true, branchId: true, deletedAt: true },
  });
}

export async function fetchLegacyFlavors(): Promise<LegacyFlavorRecord[]> {
  return prisma.flavor.findMany({
    select: { id: true, name: true, ingredientName: true, ingredientUnit: true, isActive: true },
  });
}

export async function fetchExistingUnitCodes(): Promise<{ code: string }[]> {
  return prisma.unitOfMeasure.findMany({ select: { code: true } });
}

export async function fetchSourceSummary(): Promise<SourceSummary> {
  const [
    branchCount,
    ingredientCount,
    activeIngredientCount,
    inventoryMovementCount,
    productInventoryCount,
    activeProductInventoryCount,
    flavorCount,
    activeFlavorCount,
    existingUnitOfMeasureCount,
    existingInventoryCategoryCount,
    distinctUnits,
    distinctCategories,
  ] = await Promise.all([
    prisma.branch.count(),
    prisma.ingredient.count(),
    prisma.ingredient.count({ where: { deletedAt: null } }),
    prisma.inventoryMovement.count(),
    prisma.productInventory.count(),
    prisma.productInventory.count({ where: { isActive: true, deletedAt: null } }),
    prisma.flavor.count(),
    prisma.flavor.count({ where: { isActive: true } }),
    prisma.unitOfMeasure.count(),
    prisma.inventoryCategory.count(),
    prisma.ingredient.findMany({ select: { unit: true }, distinct: ['unit'] }),
    prisma.ingredient.findMany({ select: { category: true }, distinct: ['category'] }),
  ]);

  return {
    branchCount,
    ingredientCount,
    activeIngredientCount,
    softDeletedIngredientCount: ingredientCount - activeIngredientCount,
    distinctIngredientUnitCount: distinctUnits.length,
    distinctIngredientCategoryCount: distinctCategories.length,
    productInventoryCount,
    activeProductInventoryCount,
    flavorCount,
    activeFlavorCount,
    inventoryMovementCount,
    existingUnitOfMeasureCount,
    existingInventoryCategoryCount,
  };
}
