import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateFlavorData, FlavorListFilters, UpdateFlavorData } from './flavors.types.js';

function buildWhere(filters: Pick<FlavorListFilters, 'is_active' | 'search'>): Prisma.FlavorWhereInput {
  return {
    ...(filters.is_active !== undefined && { isActive: filters.is_active }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  };
}

const SORT_FIELD_MAP: Record<NonNullable<FlavorListFilters['sort_by']>, string> = {
  name: 'name',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  display_order: 'displayOrder',
};

const branchSelect = { id: true, code: true, name: true, city: true } satisfies Prisma.BranchSelect;

/**
 * Flavors repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const flavorsRepository = {
  async findAll(filters: FlavorListFilters) {
    const where = buildWhere(filters);
    const sortField = SORT_FIELD_MAP[filters.sort_by ?? 'display_order'];
    const sortOrder = filters.sort_order ?? 'asc';

    const [flavors, total] = await Promise.all([
      prisma.flavor.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { [sortField]: sortOrder },
        include: {
          _count: { select: { variantFlavors: true } },
          branchAvailability: { select: { isAvailable: true } },
        },
      }),
      prisma.flavor.count({ where }),
    ]);

    return { flavors, total };
  },

  findById(flavorId: string) {
    return prisma.flavor.findUnique({
      where: { id: flavorId },
      include: {
        variantFlavors: {
          include: {
            productVariant: { include: { product: { select: { id: true, name: true } } } },
          },
        },
        branchAvailability: { include: { branch: { select: branchSelect } } },
      },
    });
  },

  findByName(name: string) {
    return prisma.flavor.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  },

  create(data: CreateFlavorData) {
    return prisma.flavor.create({
      data: {
        name: data.name,
        description: data.description,
        colorHex: data.colorHex,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
      },
    });
  },

  update(flavorId: string, data: UpdateFlavorData) {
    return prisma.flavor.update({
      where: { id: flavorId },
      data: {
        name: data.name,
        description: data.description,
        colorHex: data.colorHex,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
      },
    });
  },

  linkVariantFlavor(variantId: string, flavorId: string, pricePremium: number, isAvailable: boolean) {
    return prisma.productVariantFlavor.create({
      data: { productVariantId: variantId, flavorId, pricePremium, isAvailable },
      include: { flavor: true },
    });
  },

  updateVariantFlavor(variantId: string, flavorId: string, data: { pricePremium?: number; isAvailable?: boolean }) {
    return prisma.productVariantFlavor.update({
      where: { productVariantId_flavorId: { productVariantId: variantId, flavorId } },
      data: { pricePremium: data.pricePremium, isAvailable: data.isAvailable },
      include: { flavor: true },
    });
  },

  findVariantFlavorLink(variantId: string, flavorId: string) {
    return prisma.productVariantFlavor.findUnique({
      where: { productVariantId_flavorId: { productVariantId: variantId, flavorId } },
    });
  },

  async upsertBranchFlavorAvailability(
    branchId: string,
    flavorId: string,
    isAvailable: boolean,
    unavailableReason?: string | null,
  ) {
    return prisma.branchFlavorAvailability.upsert({
      where: { branchId_flavorId: { branchId, flavorId } },
      create: { branchId, flavorId, isAvailable, unavailableReason: isAvailable ? null : (unavailableReason ?? null) },
      update: { isAvailable, unavailableReason: isAvailable ? null : (unavailableReason ?? undefined) },
      include: { branch: { select: branchSelect } },
    });
  },

  findBranchFlavorAvailability(flavorId: string) {
    return prisma.branchFlavorAvailability.findMany({
      where: { flavorId },
      include: { branch: { select: branchSelect } },
    });
  },

  findLinkedVariants(flavorId: string) {
    return prisma.productVariantFlavor.findMany({
      where: { flavorId },
      include: { productVariant: { include: { product: { select: { id: true, name: true } } } } },
    });
  },

  allActiveBranches() {
    return prisma.branch.findMany({
      where: { status: 'active' },
      select: branchSelect,
      orderBy: { name: 'asc' },
    });
  },
};
