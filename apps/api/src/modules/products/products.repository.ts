import type { Prisma, ProductStatus as PrismaProductStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductData, CreateVariantData, ProductListFilters, UpdateProductData, UpdateVariantData } from './products.types.js';

const creatorInclude = {
  creator: { select: { id: true, firstName: true, lastName: true, email: true } },
  exclusiveBranch: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

const detailInclude = {
  ...creatorInclude,
  variants: {
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] as Prisma.ProductVariantOrderByWithRelationInput[],
    include: {
      variantFlavors: {
        include: { flavor: { select: { id: true, name: true, colorHex: true } } },
      },
    },
  },
  branchAvailability: {
    include: { branch: { select: { id: true, code: true, name: true, city: true } } },
  },
} satisfies Prisma.ProductInclude;

function buildWhere(filters: Pick<ProductListFilters, 'status' | 'category' | 'search' | 'is_seasonal'>): Prisma.ProductWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.category && { category: { equals: filters.category, mode: 'insensitive' } }),
    ...(filters.is_seasonal !== undefined && { isSeasonal: filters.is_seasonal }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { category: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  };
}

const SORT_FIELD_MAP: Record<NonNullable<ProductListFilters['sort_by']>, string> = {
  name: 'name',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  display_order: 'displayOrder',
  status: 'status',
};

/**
 * Products repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const productsRepository = {
  async findAll(filters: ProductListFilters) {
    const where = buildWhere(filters);
    const sortField = SORT_FIELD_MAP[filters.sort_by ?? 'created_at'];
    const sortOrder = filters.sort_order ?? 'desc';

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { [sortField]: sortOrder },
        include: {
          _count: { select: { variants: true } },
          variants: { select: { isActive: true } },
          branchAvailability: { select: { isAvailable: true } },
          exclusiveBranch: { select: { id: true, name: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return { products, total };
  },

  async findById(productId: string) {
    const result = await prisma.product.findUnique({ where: { id: productId }, include: detailInclude });
    return result;
  },

  findByName(name: string) {
    return prisma.product.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  },

  /**
   * CR-001: product creation and its branch_product_availability cascade run
   * in one transaction — a crash partway through must never leave a product
   * with no availability rows (invisible everywhere) or a half-cascaded set.
   * branch_exclusive true seeds only exclusiveBranchId; false seeds every
   * currently-active branch.
   */
  async createWithCascade(data: CreateProductData, createdBy: string) {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          name: data.name,
          description: data.description,
          category: data.category,
          status: data.status,
          displayOrder: data.displayOrder,
          isSeasonal: data.isSeasonal,
          seasonalStartDate: data.seasonalStartDate ? new Date(data.seasonalStartDate) : undefined,
          seasonalEndDate: data.seasonalEndDate ? new Date(data.seasonalEndDate) : undefined,
          imageUrl: data.imageUrl,
          branchExclusive: data.branchExclusive,
          exclusiveBranchId: data.branchExclusive ? data.exclusiveBranchId : undefined,
          createdBy,
        },
      });

      let cascadedBranchIds: string[];
      if (data.branchExclusive && data.exclusiveBranchId) {
        cascadedBranchIds = [data.exclusiveBranchId];
        await tx.branchProductAvailability.create({
          data: { branchId: data.exclusiveBranchId, productId: product.id, isAvailable: true, updatedBy: createdBy },
        });
      } else {
        const activeBranches = await tx.branch.findMany({ where: { status: 'active' }, select: { id: true } });
        cascadedBranchIds = activeBranches.map((b) => b.id);
        if (activeBranches.length > 0) {
          await tx.branchProductAvailability.createMany({
            data: activeBranches.map((b) => ({ branchId: b.id, productId: product.id, isAvailable: true, updatedBy: createdBy })),
          });
        }
      }

      const withDetail = await tx.product.findUniqueOrThrow({ where: { id: product.id }, include: detailInclude });
      return { product: withDetail, cascadedBranchIds };
    });
  },

  update(productId: string, data: UpdateProductData) {
    return prisma.product.update({
      where: { id: productId },
      data: {
        name: data.name,
        description: data.description,
        category: data.category,
        displayOrder: data.displayOrder,
        isSeasonal: data.isSeasonal,
        ...(data.seasonalStartDate !== undefined && {
          seasonalStartDate: data.seasonalStartDate ? new Date(data.seasonalStartDate) : null,
        }),
        ...(data.seasonalEndDate !== undefined && {
          seasonalEndDate: data.seasonalEndDate ? new Date(data.seasonalEndDate) : null,
        }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
      },
      include: detailInclude,
    });
  },

  updateStatus(productId: string, status: PrismaProductStatus) {
    return prisma.product.update({
      where: { id: productId },
      data: { status },
      include: detailInclude,
    });
  },

  updateImage(productId: string, imageUrl: string) {
    return prisma.product.update({ where: { id: productId }, data: { imageUrl }, include: detailInclude });
  },

  clearImage(productId: string) {
    return prisma.product.update({ where: { id: productId }, data: { imageUrl: null }, include: detailInclude });
  },

  countActiveBranches(productId: string) {
    return prisma.branchProductAvailability.count({ where: { productId, isAvailable: true } });
  },

  createVariant(productId: string, data: CreateVariantData) {
    return prisma.productVariant.create({
      data: {
        productId,
        name: data.name,
        sizeLabel: data.sizeLabel,
        basePrice: data.basePrice,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
      },
    });
  },

  updateVariant(variantId: string, data: UpdateVariantData) {
    return prisma.productVariant.update({
      where: { id: variantId },
      data: {
        name: data.name,
        sizeLabel: data.sizeLabel,
        basePrice: data.basePrice,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
      },
    });
  },

  findVariantById(variantId: string) {
    return prisma.productVariant.findUnique({
      where: { id: variantId },
      include: {
        product: true,
        variantFlavors: { include: { flavor: { select: { id: true, name: true, colorHex: true } } } },
      },
    });
  },

  /** Deletes the variant's own flavor links first (config, not history), then the variant — one transaction so a P2003 on the variant leaves the links intact. */
  deleteVariantCascade(variantId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.productVariantFlavor.deleteMany({ where: { productVariantId: variantId } });
      return tx.productVariant.delete({ where: { id: variantId } });
    });
  },

  /** Deletes the product's own config rows (branch availability, each variant's flavor links) then its variants then the product — one transaction so a P2003 anywhere rolls the whole thing back. */
  deleteProductCascade(productId: string, variantIds: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.branchProductAvailability.deleteMany({ where: { productId } });
      for (const variantId of variantIds) {
        await tx.productVariantFlavor.deleteMany({ where: { productVariantId: variantId } });
        await tx.productVariant.delete({ where: { id: variantId } });
      }
      return tx.product.delete({ where: { id: productId } });
    });
  },

  async upsertBranchProductAvailability(
    branchId: string,
    productId: string,
    isAvailable: boolean,
    updatedBy: string,
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return tx.branchProductAvailability.upsert({
      where: { branchId_productId: { branchId, productId } },
      create: { branchId, productId, isAvailable, updatedBy },
      update: { isAvailable, updatedBy },
      include: { branch: { select: { id: true, code: true, name: true, city: true } } },
    });
  },

  findBranchProductAvailability(productId: string) {
    return prisma.branchProductAvailability.findMany({
      where: { productId },
      include: { branch: { select: { id: true, code: true, name: true, city: true } } },
    });
  },

  /** Sets every branch_product_availability row for this product to unavailable — used when a product goes discontinued or archived globally. */
  cascadeBranchAvailabilityOff(productId: string, updatedBy: string) {
    return prisma.branchProductAvailability.updateMany({
      where: { productId, isAvailable: true },
      data: { isAvailable: false, updatedBy },
    });
  },

  getProductsByGlobalStatus(statuses: PrismaProductStatus[]) {
    return prisma.product.findMany({ where: { status: { in: statuses } } });
  },

  allActiveBranches() {
    return prisma.branch.findMany({
      where: { status: 'active' },
      select: { id: true, code: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
  },

  findActiveBranch(branchId: string) {
    return prisma.branch.findFirst({ where: { id: branchId, status: 'active' }, select: { id: true, name: true } });
  },

  /** Phase 10 POS terminal catalog — active products, available at this branch, with only active variants and available flavors. */
  findCatalogForBranch(branchId: string) {
    return prisma.product.findMany({
      where: {
        status: 'active',
        branchAvailability: { some: { branchId, isAvailable: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      include: {
        variants: {
          where: { isActive: true },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            variantFlavors: {
              where: { isAvailable: true, flavor: { isActive: true } },
              include: { flavor: { select: { id: true, name: true, colorHex: true } } },
            },
          },
        },
      },
    });
  },

  async findDisabledFlavorIds(branchId: string): Promise<string[]> {
    const rows = await prisma.branchFlavorAvailability.findMany({
      where: { branchId, isAvailable: false },
      select: { flavorId: true },
    });
    return rows.map((r) => r.flavorId);
  },
};
