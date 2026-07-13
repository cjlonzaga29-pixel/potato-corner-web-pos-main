import { prisma } from '../../lib/prisma.js';
import type { CreateIngredientData } from './inventory.types.js';

/**
 * Inventory repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly. Phase 7 foundation:
 * ingredient master data only — stock movements, physical counts, and the
 * out-of-stock cascade remain Phase 8 scope (locked rule: "All inventory
 * management (already in scope for Phase 8)").
 */
export const inventoryRepository = {
  findAllIngredients(branchId?: string) {
    return prisma.ingredient.findMany({
      where: branchId ? { branchId } : undefined,
      orderBy: { name: 'asc' },
    });
  },

  findIngredientById(id: string) {
    return prisma.ingredient.findUnique({ where: { id } });
  },

  createIngredient(data: CreateIngredientData) {
    return prisma.ingredient.create({
      data: {
        branchId: data.branchId,
        name: data.name,
        unit: data.unit,
        currentStock: data.currentStock,
        lowStockThreshold: data.lowStockThreshold,
        criticalThreshold: data.criticalThreshold,
        unitCost: data.unitCost,
      },
    });
  },
};
