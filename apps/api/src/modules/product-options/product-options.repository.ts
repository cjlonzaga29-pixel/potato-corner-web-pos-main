import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type {
  AssignVariantOptionGroupData,
  CreateOptionData,
  CreateOptionGroupData,
  OptionGroupListFilters,
  UpdateOptionData,
  UpdateOptionGroupData,
  UpdateVariantOptionGroupData,
} from './product-options.types.js';

function buildGroupWhere(filters: Pick<OptionGroupListFilters, 'is_active' | 'search'>): Prisma.ProductOptionGroupWhereInput {
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

const SORT_FIELD_MAP: Record<NonNullable<OptionGroupListFilters['sort_by']>, string> = {
  name: 'name',
  code: 'code',
  sort_order: 'sortOrder',
  created_at: 'createdAt',
};

const variantOptionGroupInclude = {
  optionGroup: true,
  allowedOptions: {
    include: { productOption: true },
    orderBy: { sortOrder: 'asc' },
  },
} satisfies Prisma.ProductVariantOptionGroupInclude;

/**
 * Product Option Groups / Options / Variant-assignment repository (CR-008
 * R4/R5/R6). All Prisma calls for this module live here — the router and
 * service layers never call Prisma directly.
 */
export const productOptionsRepository = {
  async findAllGroups(filters: OptionGroupListFilters) {
    const where = buildGroupWhere(filters);
    const sortField = SORT_FIELD_MAP[filters.sort_by ?? 'sort_order'];
    const sortOrder = filters.sort_order ?? 'asc';

    const [groups, total] = await Promise.all([
      prisma.productOptionGroup.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { [sortField]: sortOrder },
        include: { _count: { select: { options: true } } },
      }),
      prisma.productOptionGroup.count({ where }),
    ]);

    return { groups, total };
  },

  findGroupById(id: string) {
    return prisma.productOptionGroup.findUnique({
      where: { id },
      include: {
        _count: { select: { options: true } },
        options: { orderBy: { sortOrder: 'asc' } },
      },
    });
  },

  findGroupByCode(code: string) {
    return prisma.productOptionGroup.findUnique({ where: { code } });
  },

  createGroup(data: CreateOptionGroupData) {
    return prisma.productOptionGroup.create({
      data: {
        code: data.code,
        name: data.name,
        description: data.description,
        selectionType: data.selectionType,
        minSelections: data.minSelections,
        maxSelections: data.maxSelections,
        required: data.required,
        isActive: data.isActive,
        sortOrder: data.sortOrder,
        createdBy: data.createdBy,
      },
      include: { _count: { select: { options: true } } },
    });
  },

  updateGroup(id: string, data: UpdateOptionGroupData) {
    return prisma.productOptionGroup.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        selectionType: data.selectionType,
        minSelections: data.minSelections,
        maxSelections: data.maxSelections,
        required: data.required,
        isActive: data.isActive,
        sortOrder: data.sortOrder,
      },
      include: { _count: { select: { options: true } } },
    });
  },

  findOptionById(id: string) {
    return prisma.productOption.findUnique({ where: { id } });
  },

  findOptionByCode(optionGroupId: string, code: string) {
    return prisma.productOption.findUnique({ where: { optionGroupId_code: { optionGroupId, code } } });
  },

  createOption(data: CreateOptionData) {
    return prisma.productOption.create({
      data: {
        optionGroupId: data.optionGroupId,
        code: data.code,
        name: data.name,
        priceAdjustment: data.priceAdjustment,
        imageUrl: data.imageUrl,
        isActive: data.isActive,
        sortOrder: data.sortOrder,
        createdBy: data.createdBy,
      },
    });
  },

  updateOption(id: string, data: UpdateOptionData) {
    return prisma.productOption.update({
      where: { id },
      data: {
        name: data.name,
        priceAdjustment: data.priceAdjustment,
        imageUrl: data.imageUrl,
        isActive: data.isActive,
        sortOrder: data.sortOrder,
      },
    });
  },

  // --- Variant <-> Option Group assignment (R6) ---

  findVariantOptionGroups(productVariantId: string) {
    return prisma.productVariantOptionGroup.findMany({
      where: { productVariantId },
      orderBy: { sortOrder: 'asc' },
      include: variantOptionGroupInclude,
    });
  },

  findVariantOptionGroupAssignment(productVariantId: string, optionGroupId: string) {
    return prisma.productVariantOptionGroup.findUnique({
      where: { productVariantId_optionGroupId: { productVariantId, optionGroupId } },
    });
  },

  findVariantOptionGroupById(id: string) {
    return prisma.productVariantOptionGroup.findUnique({ where: { id }, include: variantOptionGroupInclude });
  },

  async assignOptionGroup(productVariantId: string, data: AssignVariantOptionGroupData) {
    const assignment = await prisma.productVariantOptionGroup.create({
      data: {
        productVariantId,
        optionGroupId: data.optionGroupId,
        required: data.required ?? null,
        sortOrder: data.sortOrder,
        createdBy: data.createdBy,
      },
    });

    if (data.allowedOptionIds && data.allowedOptionIds.length > 0) {
      await prisma.productVariantOptionGroupOption.createMany({
        data: data.allowedOptionIds.map((productOptionId, index) => ({
          variantOptionGroupId: assignment.id,
          productOptionId,
          sortOrder: index,
        })),
      });
    }

    return prisma.productVariantOptionGroup.findUniqueOrThrow({ where: { id: assignment.id }, include: variantOptionGroupInclude });
  },

  async updateVariantOptionGroup(id: string, data: UpdateVariantOptionGroupData) {
    await prisma.productVariantOptionGroup.update({
      where: { id },
      data: { required: data.required, sortOrder: data.sortOrder },
    });

    if (data.allowedOptionIds !== undefined) {
      await prisma.$transaction([
        prisma.productVariantOptionGroupOption.deleteMany({ where: { variantOptionGroupId: id } }),
        ...(data.allowedOptionIds.length > 0
          ? [
              prisma.productVariantOptionGroupOption.createMany({
                data: data.allowedOptionIds.map((productOptionId, index) => ({
                  variantOptionGroupId: id,
                  productOptionId,
                  sortOrder: index,
                })),
              }),
            ]
          : []),
      ]);
    }

    return prisma.productVariantOptionGroup.findUniqueOrThrow({ where: { id }, include: variantOptionGroupInclude });
  },

  deleteVariantOptionGroup(id: string) {
    return prisma.productVariantOptionGroup.delete({ where: { id } });
  },
};
