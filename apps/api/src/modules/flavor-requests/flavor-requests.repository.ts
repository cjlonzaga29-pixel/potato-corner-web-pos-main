import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateFlavorRequestData, FlavorRequestListFilters } from './flavor-requests.types.js';

const detailInclude = {
  branch: { select: { id: true, name: true, code: true } },
  requester: { select: { id: true, firstName: true, lastName: true } },
  reviewer: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.FlavorRequestInclude;

function buildWhere(filters: Pick<FlavorRequestListFilters, 'status' | 'branch_id' | 'requested_by'>): Prisma.FlavorRequestWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.branch_id && { branchId: filters.branch_id }),
    ...(filters.requested_by && { requestedBy: filters.requested_by }),
  };
}

/**
 * Flavor requests repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const flavorRequestsRepository = {
  async findAll(filters: FlavorRequestListFilters) {
    const where = buildWhere(filters);
    const [requests, total] = await Promise.all([
      prisma.flavorRequest.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        include: detailInclude,
      }),
      prisma.flavorRequest.count({ where }),
    ]);
    return { requests, total };
  },

  findById(id: string) {
    return prisma.flavorRequest.findUnique({ where: { id }, include: detailInclude });
  },

  create(data: CreateFlavorRequestData, requestedBy: string) {
    return prisma.flavorRequest.create({
      data: {
        branchId: data.branchId,
        requestedBy,
        proposedName: data.proposedName,
        proposedDescription: data.proposedDescription,
        proposedColorHex: data.proposedColorHex,
        proposedDisplayOrder: data.proposedDisplayOrder,
        requestReason: data.requestReason,
      },
      include: detailInclude,
    });
  },

  updateStatus(
    id: string,
    data: { status: string; reviewedBy: string; reviewNotes?: string; createdFlavorId?: string },
  ) {
    return prisma.flavorRequest.update({
      where: { id },
      data: {
        status: data.status,
        reviewedBy: data.reviewedBy,
        reviewedAt: new Date(),
        reviewNotes: data.reviewNotes,
        createdFlavorId: data.createdFlavorId,
      },
      include: detailInclude,
    });
  },
};
