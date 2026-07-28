import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const variantInclude = {
  product: { select: { id: true, name: true, status: true, branchExclusive: true, exclusiveBranchId: true } },
  productComponents: {
    where: { deletedAt: null },
    select: {
      id: true,
      inventoryItemId: true,
      quantityRequired: true,
      inventoryItem: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
          identityMappings: { select: { mappingStatus: true } },
        },
      },
    },
  },
  productInventory: {
    where: { deletedAt: null },
    select: { id: true, flavorId: true },
  },
} satisfies Prisma.ProductVariantInclude;

export type ReadinessVariantRow = Prisma.ProductVariantGetPayload<{ include: typeof variantInclude }>;

/**
 * Pure read layer for CR-011.2. Every query here is a plain fetch — no
 * writes, no mutation of ProductComponent/InventoryStock/ProductInventory.
 */
export const recipeReadinessRepository = {
  findVariants(filters: { productId?: string; productVariantId?: string }): Promise<ReadinessVariantRow[]> {
    return prisma.productVariant.findMany({
      where: {
        ...(filters.productVariantId !== undefined && { id: filters.productVariantId }),
        ...(filters.productId !== undefined && { productId: filters.productId }),
      },
      orderBy: [{ productId: 'asc' }, { displayOrder: 'asc' }],
      include: variantInclude,
    });
  },

  findAllActiveBranches(): Promise<Array<{ id: string }>> {
    return prisma.branch.findMany({ where: { status: 'active' }, select: { id: true } });
  },

  findBranchAvailability(productIds: string[]): Promise<Array<{ productId: string; branchId: string; isAvailable: boolean }>> {
    return prisma.branchProductAvailability.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, branchId: true, isAvailable: true },
    });
  },

  findAllStockKeys(): Promise<Array<{ branchId: string; inventoryItemId: string }>> {
    return prisma.inventoryStock.findMany({ select: { branchId: true, inventoryItemId: true } });
  },

  /**
   * InventoryItems affected by an unresolved backfill conflict — an
   * InventoryProjectionOutbox row that is deferred/stuck for a movement
   * whose ingredient resolves (via accepted identity mapping) to that item.
   */
  async findConflictedInventoryItemIds(): Promise<Set<string>> {
    const rows = await prisma.inventoryProjectionOutbox.findMany({
      where: { status: { in: ['deferred', 'stuck'] } },
      select: {
        movement: {
          select: {
            ingredient: {
              select: {
                identityMapping: { select: { inventoryItemId: true, mappingStatus: true } },
              },
            },
          },
        },
      },
    });

    const conflicted = new Set<string>();
    for (const row of rows) {
      const mapping = row.movement.ingredient.identityMapping;
      if (mapping?.inventoryItemId && (mapping.mappingStatus === 'AUTO_MATCHED' || mapping.mappingStatus === 'MANUALLY_MATCHED')) {
        conflicted.add(mapping.inventoryItemId);
      }
    }
    return conflicted;
  },
};
