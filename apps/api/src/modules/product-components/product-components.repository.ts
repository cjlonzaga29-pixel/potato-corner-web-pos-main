import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductComponentData, UpdateProductComponentData } from './product-components.types.js';

const productComponentInclude = {
  inventoryItem: { select: { id: true, name: true, sku: true, baseUnit: { select: { code: true } } } },
} satisfies Prisma.ProductComponentInclude;

/**
 * CR-010 R8 — extensible ProductVariant -> InventoryItem mapping only.
 * No Recipe/BOM logic and no POS deduction reads this table; it exists so
 * a future CR can build deduction against Universal Inventory without a
 * schema change (CR-007 §10).
 */
export const productComponentsRepository = {
  findByVariant(productVariantId: string) {
    return prisma.productComponent.findMany({
      where: { productVariantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: productComponentInclude,
    });
  },

  findById(id: string) {
    return prisma.productComponent.findFirst({ where: { id, deletedAt: null }, include: productComponentInclude });
  },

  findByVariantAndItem(productVariantId: string, inventoryItemId: string) {
    return prisma.productComponent.findFirst({
      where: { productVariantId, inventoryItemId, deletedAt: null },
    });
  },

  create(data: CreateProductComponentData) {
    return prisma.productComponent.create({
      data: {
        productVariantId: data.productVariantId,
        inventoryItemId: data.inventoryItemId,
        quantityRequired: data.quantityRequired,
      },
      include: productComponentInclude,
    });
  },

  update(id: string, data: UpdateProductComponentData) {
    return prisma.productComponent.update({
      where: { id },
      data: {
        ...(data.quantityRequired !== undefined && { quantityRequired: data.quantityRequired }),
        version: { increment: 1 },
      },
      include: productComponentInclude,
    });
  },

  delete(id: string, updatedBy: string) {
    return prisma.productComponent.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy },
    });
  },
};
