import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductTypeData, UpdateProductTypeData } from './product-types.types.js';

const typeInclude = {
  branches: { select: { branchId: true, branch: { select: { name: true } } } },
} satisfies Prisma.ProductTypeInclude;

/** POS-PERF-P58 — all Prisma calls for this module live here. */
export const productTypesRepository = {
  findMany(where: { branchIds?: string[]; includeInactive: boolean }) {
    return prisma.productType.findMany({
      where: {
        ...(where.includeInactive ? {} : { isActive: true }),
        ...(where.branchIds && { branches: { some: { branchId: { in: where.branchIds } } } }),
      },
      include: typeInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },

  findById(productTypeId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
    return client.productType.findUnique({ where: { id: productTypeId }, include: typeInclude });
  },

  async countProductsByType(productTypeIds: string[]) {
    if (productTypeIds.length === 0) return new Map<string, number>();
    const rows = await prisma.product.groupBy({ by: ['productTypeId'], where: { productTypeId: { in: productTypeIds } }, _count: { _all: true } });
    return new Map(rows.map((row) => [row.productTypeId as string, row._count._all]));
  },

  findActiveBranchIds(branchIds: string[]) {
    return prisma.branch.findMany({ where: { id: { in: branchIds }, status: 'active' }, select: { id: true } });
  },

  create(data: CreateProductTypeData) {
    return prisma.$transaction(async (tx) => {
      const type = await tx.productType.create({
        data: { name: data.name, normalizedName: data.normalizedName, description: data.description, createdById: data.createdById },
      });
      await tx.productTypeBranch.createMany({
        data: data.branchIds.map((branchId) => ({ productTypeId: type.id, branchId, normalizedName: data.normalizedName, isActive: true })),
      });
      return tx.productType.findUniqueOrThrow({ where: { id: type.id }, include: typeInclude });
    });
  },

  /** Compare-and-swap on version, as products.update. Null when the version moved. */
  update(productTypeId: string, data: UpdateProductTypeData, expectedVersion: number, addedBranchIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.productType.updateMany({
        where: { id: productTypeId, version: expectedVersion },
        data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (count === 0) return null;
      const row = await tx.productType.findUniqueOrThrow({ where: { id: productTypeId }, include: typeInclude });
      if (addedBranchIds.length === 0) return row;
      await tx.productTypeBranch.createMany({
        data: addedBranchIds.map((branchId) => ({ productTypeId, branchId, normalizedName: row.normalizedName, isActive: row.isActive })),
      });
      return tx.productType.findUniqueOrThrow({ where: { id: productTypeId }, include: typeInclude });
    });
  },

  /** Only ever touches this row: products keep their type, status, availability and stock. */
  async setActive(productTypeId: string, isActive: boolean, expectedVersion: number, actorId: string) {
    const { count } = await prisma.productType.updateMany({
      where: { id: productTypeId, version: expectedVersion },
      data: { isActive, deactivatedAt: isActive ? null : new Date(), updatedById: actorId, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (count === 0) return null;
    return prisma.productType.findUniqueOrThrow({ where: { id: productTypeId }, include: typeInclude });
  },

  /**
   * True when the type is active, holding its row lock until the caller's
   * transaction ends: the update writes the value it matched, so nothing changes
   * (version and updatedAt included) and nothing cascades.
   */
  async lockActive(productTypeId: string, tx: Prisma.TransactionClient) {
    const { count } = await tx.productType.updateMany({ where: { id: productTypeId, isActive: true }, data: { isActive: true } });
    return count === 1;
  },
};

export type ProductTypeRow = NonNullable<Awaited<ReturnType<typeof productTypesRepository.findById>>>;
