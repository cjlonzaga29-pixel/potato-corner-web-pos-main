import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateProductCategoryData, ProductCategoryListFilters, UpdateProductCategoryData } from './product-categories.types.js';

function buildWhere(filters: Pick<ProductCategoryListFilters, 'is_active' | 'search'>): Prisma.ProductCategoryWhereInput {
  return {
    ...(filters.is_active !== undefined && { isActive: filters.is_active }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { code: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  };
}

const SORT_FIELD_MAP: Record<NonNullable<ProductCategoryListFilters['sort_by']>, string> = {
  name: 'name',
  code: 'code',
  sort_order: 'sortOrder',
  created_at: 'createdAt',
};

/**
 * Product Categories repository (CR-008 R1). All Prisma calls for this
 * module live here — the router and service layers never call Prisma
 * directly.
 */
export const productCategoriesRepository = {
  async findAll(filters: ProductCategoryListFilters) {
    const where = buildWhere(filters);
    const sortField = SORT_FIELD_MAP[filters.sort_by ?? 'sort_order'];
    const sortOrder = filters.sort_order ?? 'asc';

    const [categories, total] = await Promise.all([
      prisma.productCategory.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { [sortField]: sortOrder },
        include: { _count: { select: { products: true } } },
      }),
      prisma.productCategory.count({ where }),
    ]);

    return { categories, total };
  },

  findById(id: string) {
    return prisma.productCategory.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
  },

  findByCode(code: string) {
    return prisma.productCategory.findUnique({ where: { code } });
  },

  create(data: CreateProductCategoryData) {
    return prisma.productCategory.create({
      data: {
        code: data.code,
        name: data.name,
        description: data.description,
        isActive: data.isActive,
        sortOrder: data.sortOrder,
        createdBy: data.createdBy,
      },
      include: { _count: { select: { products: true } } },
    });
  },

  update(id: string, data: UpdateProductCategoryData) {
    return prisma.productCategory.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        isActive: data.isActive,
        sortOrder: data.sortOrder,
      },
      include: { _count: { select: { products: true } } },
    });
  },
};
