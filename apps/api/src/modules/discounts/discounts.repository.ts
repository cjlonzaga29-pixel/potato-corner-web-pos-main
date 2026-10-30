import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { PromotionWriteData } from './discounts.types.js';

/**
 * Discounts repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */

/** Manila calendar date (YYYY-MM-DD) -> the value Prisma stores in a @db.Date column. */
export function toDateColumn(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

/** Inverse of toDateColumn; @db.Date values come back at UTC midnight. */
export function fromDateColumn(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

const promotionInclude = {
  products: { include: { product: { select: { id: true, name: true, classification: true } } } },
  branches: { include: { branch: { select: { id: true, name: true } } } },
} satisfies Prisma.PromotionInclude;

export type PromotionRow = Prisma.PromotionGetPayload<{ include: typeof promotionInclude }>;

const productForPromotionSelect = {
  id: true,
  name: true,
  status: true,
  classification: true,
  branchAvailability: { select: { branchId: true } },
  variants: {
    select: { id: true, name: true, basePrice: true, vatableCapAmount: true, isActive: true, displayOrder: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  },
} satisfies Prisma.ProductSelect;

export type ProductForPromotionRow = Prisma.ProductGetPayload<{ select: typeof productForPromotionSelect }>;

function writeRelations(data: PromotionWriteData) {
  return {
    products: { create: data.productIds.map((productId) => ({ productId })) },
    branches: { create: data.branchIds.map((branchId) => ({ branchId })) },
  };
}

export const discountsRepository = {
  /** branchIds 'all' = every promotion (super_admin); otherwise promotions touching any of these branches. */
  listPromotions(branchIds: 'all' | string[]): Promise<PromotionRow[]> {
    return prisma.promotion.findMany({
      where: branchIds === 'all' ? {} : { branches: { some: { branchId: { in: branchIds } } } },
      include: promotionInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  },

  findPromotionById(id: string): Promise<PromotionRow | null> {
    return prisma.promotion.findUnique({ where: { id }, include: promotionInclude });
  },

  /** Products configured (any availability row) at any of these branches, for the editor's product picker. */
  findProductsAtBranches(branchIds: string[]): Promise<ProductForPromotionRow[]> {
    return prisma.product.findMany({
      where: { branchAvailability: { some: { branchId: { in: branchIds } } } },
      select: productForPromotionSelect,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },

  findProductsByIds(productIds: string[]): Promise<ProductForPromotionRow[]> {
    return prisma.product.findMany({ where: { id: { in: productIds } }, select: productForPromotionSelect });
  },

  /** Active (non-archived) branch ids among these. */
  async findActiveBranchIds(branchIds: string[]): Promise<string[]> {
    const rows = await prisma.branch.findMany({ where: { id: { in: branchIds }, status: 'active' }, select: { id: true } });
    return rows.map((row) => row.id);
  },

  createPromotion(data: PromotionWriteData, actorId: string): Promise<PromotionRow> {
    return prisma.promotion.create({
      data: {
        name: data.name,
        discountKind: data.discountKind,
        discountValue: data.discountValue,
        isEnabled: data.isEnabled,
        applicationMode: data.applicationMode,
        startsOn: toDateColumn(data.startsOn),
        endsOn: toDateColumn(data.endsOn),
        createdById: actorId,
        ...writeRelations(data),
      },
      include: promotionInclude,
    });
  },

  /**
   * Compare-and-swap on version (same contract as productsRepository.update):
   * returns null when someone else saved first. Product/branch selections are
   * replaced in the same transaction as the version bump.
   */
  async updatePromotion(id: string, expectedVersion: number, data: PromotionWriteData, actorId: string): Promise<PromotionRow | null> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.promotion.updateMany({
        where: { id, version: expectedVersion },
        data: {
          name: data.name,
          discountKind: data.discountKind,
          discountValue: data.discountValue,
          isEnabled: data.isEnabled,
          applicationMode: data.applicationMode,
          startsOn: toDateColumn(data.startsOn),
          endsOn: toDateColumn(data.endsOn),
          updatedById: actorId,
          version: { increment: 1 },
        },
      });
      if (count === 0) return null;
      await tx.promotionProduct.deleteMany({ where: { promotionId: id } });
      await tx.promotionBranch.deleteMany({ where: { promotionId: id } });
      await tx.promotionProduct.createMany({ data: data.productIds.map((productId) => ({ promotionId: id, productId })) });
      await tx.promotionBranch.createMany({ data: data.branchIds.map((branchId) => ({ promotionId: id, branchId })) });
      return tx.promotion.findUniqueOrThrow({ where: { id }, include: promotionInclude });
    });
  },

  async setPromotionEnabled(id: string, expectedVersion: number, isEnabled: boolean, actorId: string): Promise<PromotionRow | null> {
    const { count } = await prisma.promotion.updateMany({
      where: { id, version: expectedVersion },
      data: { isEnabled, updatedById: actorId, version: { increment: 1 } },
    });
    if (count === 0) return null;
    return prisma.promotion.findUniqueOrThrow({ where: { id }, include: promotionInclude });
  },

  /**
   * Checkout/catalog read: enabled promotions selecting this branch and any of
   * these products, with only the matching product ids. Schedule filtering is
   * done by the caller (pure, Manila-date based) so it is unit-testable.
   */
  findEnabledPromotionsForBranch(branchId: string, productIds: string[]) {
    return prisma.promotion.findMany({
      where: {
        isEnabled: true,
        // POS-PERF-P50R — cashier-selected discounts never apply automatically.
        applicationMode: 'automatic',
        branches: { some: { branchId } },
        products: { some: { productId: { in: productIds } } },
      },
      select: {
        id: true,
        name: true,
        discountKind: true,
        discountValue: true,
        isEnabled: true,
        startsOn: true,
        endsOn: true,
        version: true,
        createdAt: true,
        products: { where: { productId: { in: productIds } }, select: { productId: true } },
      },
    });
  },

  /** Current classification/status per product, re-read at checkout so a reclassified product stops discounting immediately. */
  findProductClassifications(productIds: string[]) {
    return prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, classification: true, status: true },
    });
  },

  /**
   * POS-PERF-P50R — enabled cashier-selected discounts at this branch, with
   * the products they name (schedule filtered by the caller, as above).
   * promotionId narrows to the one a checkout claims.
   */
  findEnabledSelectableDiscounts(branchId: string, promotionId?: string) {
    return prisma.promotion.findMany({
      where: {
        isEnabled: true,
        applicationMode: 'cashier_selected',
        branches: { some: { branchId } },
        ...(promotionId ? { id: promotionId } : {}),
      },
      select: {
        id: true,
        name: true,
        discountKind: true,
        discountValue: true,
        isEnabled: true,
        startsOn: true,
        endsOn: true,
        version: true,
        createdAt: true,
        products: { select: { productId: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },
};
