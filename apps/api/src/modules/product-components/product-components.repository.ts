import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductComponentData, UpdateProductComponentData } from './product-components.types.js';

const productComponentInclude = {
  inventoryItem: { select: { id: true, name: true, sku: true, baseUnit: { select: { code: true } } } },
} satisfies Prisma.ProductComponentInclude;

/**
 * CR-011.1 — Recipe/BOM: ProductVariant -> InventoryItem mapping with
 * quantity required. No POS deduction reads this table yet; it exists so a
 * future CR can build deduction against Universal Inventory without a
 * schema change (CR-007 §10). Legacy ProductInventory remains the live POS
 * deduction source during this phase.
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
        ...(data.createdBy !== undefined && { createdBy: data.createdBy }),
      },
      include: productComponentInclude,
    });
  },

  /** Includes soft-deleted rows — used by the legacy backfill's idempotency check, which must distinguish "never created" from "created then deactivated". */
  findByVariantAndItemAnyState(productVariantId: string, inventoryItemId: string) {
    return prisma.productComponent.findFirst({
      where: { productVariantId, inventoryItemId },
    });
  },

  update(id: string, data: UpdateProductComponentData) {
    return prisma.productComponent.update({
      where: { id },
      data: {
        ...(data.quantityRequired !== undefined && { quantityRequired: data.quantityRequired }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
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
