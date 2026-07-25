import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductInventoryData, UpdateProductInventoryData } from './product-inventory.types.js';

/** Joined for display in Product Management's business-neutral inventory-mapping UI (Phase 6) — same shape as recipesRepository's ingredient include. */
const productInventoryInclude = {
  ingredient: { select: { id: true, name: true } },
} satisfies Prisma.ProductInventoryInclude;

/**
 * ProductInventory repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const productInventoryRepository = {
  findByVariant(productVariantId: string) {
    return prisma.productInventory.findMany({
      where: { productVariantId },
      orderBy: { createdAt: 'asc' },
      include: productInventoryInclude,
    });
  },

  findById(id: string) {
    return prisma.productInventory.findUnique({ where: { id }, include: productInventoryInclude });
  },

  findByVariantAndIngredient(productVariantId: string, ingredientId: string) {
    return prisma.productInventory.findUnique({
      where: { productVariantId_ingredientId: { productVariantId, ingredientId } },
    });
  },

  create(data: CreateProductInventoryData) {
    return prisma.productInventory.create({
      data: {
        productVariantId: data.productVariantId,
        ingredientId: data.ingredientId,
        quantityRequired: data.quantityRequired,
        unit: data.unit,
      },
      include: productInventoryInclude,
    });
  },

  update(id: string, data: UpdateProductInventoryData) {
    return prisma.productInventory.update({
      where: { id },
      data: {
        ...(data.quantityRequired !== undefined && { quantityRequired: data.quantityRequired }),
        ...(data.unit !== undefined && { unit: data.unit }),
      },
      include: productInventoryInclude,
    });
  },

  delete(id: string) {
    return prisma.productInventory.delete({ where: { id } });
  },
};
