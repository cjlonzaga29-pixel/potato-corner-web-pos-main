import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreatePriceOverrideData, PriceOverrideListFilters } from './price-overrides.types.js';

const detailInclude = {
  branch: { select: { id: true, name: true } },
  productVariant: { select: { id: true, name: true, basePrice: true, product: { select: { name: true } } } },
  requester: { select: { id: true, firstName: true, lastName: true } },
  reviewer: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.BranchPriceOverrideInclude;

function buildWhere(filters: Pick<PriceOverrideListFilters, 'status' | 'branch_id'>): Prisma.BranchPriceOverrideWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.branch_id && { branchId: filters.branch_id }),
  };
}

/**
 * Price overrides repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const priceOverridesRepository = {
  async findAll(filters: PriceOverrideListFilters) {
    const where = buildWhere(filters);
    const [overrides, total] = await Promise.all([
      prisma.branchPriceOverride.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        include: detailInclude,
      }),
      prisma.branchPriceOverride.count({ where }),
    ]);
    return { overrides, total };
  },

  findById(id: string) {
    return prisma.branchPriceOverride.findUnique({ where: { id }, include: detailInclude });
  },

  findPendingForVariant(branchId: string, productVariantId: string) {
    return prisma.branchPriceOverride.findFirst({ where: { branchId, productVariantId, status: 'pending' } });
  },

  /** Used by getActivePriceForBranch (exported for Phase 10's transaction/POS pricing lookup). */
  findActiveOverride(branchId: string, productVariantId: string) {
    return prisma.branchPriceOverride.findFirst({
      where: { branchId, productVariantId, status: 'approved' },
      orderBy: { reviewedAt: 'desc' },
    });
  },

  create(data: CreatePriceOverrideData, requestedBy: string) {
    return prisma.branchPriceOverride.create({
      data: {
        branchId: data.branchId,
        productVariantId: data.productVariantId,
        requestedPrice: data.requestedPrice,
        requestedBy,
        requestReason: data.requestReason,
      },
      include: detailInclude,
    });
  },

  updateStatus(id: string, data: { status: string; reviewedBy: string; reviewNotes?: string; effectiveFrom?: Date }) {
    return prisma.branchPriceOverride.update({
      where: { id },
      data: {
        status: data.status,
        reviewedBy: data.reviewedBy,
        reviewedAt: new Date(),
        reviewNotes: data.reviewNotes,
        effectiveFrom: data.effectiveFrom,
      },
      include: detailInclude,
    });
  },
};
