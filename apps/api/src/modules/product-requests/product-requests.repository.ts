import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductRequestData, ProductRequestListFilters } from './product-requests.types.js';

const detailInclude = {
  branch: { select: { id: true, name: true, code: true } },
  requester: { select: { id: true, firstName: true, lastName: true } },
  reviewer: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ProductRequestInclude;

function buildWhere(filters: Pick<ProductRequestListFilters, 'status' | 'branch_id' | 'requested_by'>): Prisma.ProductRequestWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.branch_id && { branchId: filters.branch_id }),
    ...(filters.requested_by && { requestedBy: filters.requested_by }),
  };
}

/**
 * Product requests repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const productRequestsRepository = {
  async findAll(filters: ProductRequestListFilters) {
    const where = buildWhere(filters);
    const [requests, total] = await Promise.all([
      prisma.productRequest.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        include: detailInclude,
      }),
      prisma.productRequest.count({ where }),
    ]);
    return { requests, total };
  },

  findById(id: string) {
    return prisma.productRequest.findUnique({ where: { id }, include: detailInclude });
  },

  create(data: CreateProductRequestData, requestedBy: string) {
    return prisma.productRequest.create({
      data: {
        branchId: data.branchId,
        requestedBy,
        proposedName: data.proposedName,
        proposedDescription: data.proposedDescription,
        proposedCategory: data.proposedCategory,
        proposedVariants: data.proposedVariants as Prisma.InputJsonValue,
        proposedFlavors: data.proposedFlavors as Prisma.InputJsonValue,
        proposedRecipes: data.proposedRecipes as Prisma.InputJsonValue,
        requestReason: data.requestReason,
      },
      include: detailInclude,
    });
  },

  updateStatus(
    id: string,
    data: { status: string; reviewedBy: string; reviewNotes?: string; createdProductId?: string },
  ) {
    return prisma.productRequest.update({
      where: { id },
      data: {
        status: data.status,
        reviewedBy: data.reviewedBy,
        reviewedAt: new Date(),
        reviewNotes: data.reviewNotes,
        createdProductId: data.createdProductId,
      },
      include: detailInclude,
    });
  },
};
