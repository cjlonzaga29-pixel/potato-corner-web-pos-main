import type { JwtPayload } from '@potato-corner/shared';
import { productCategoriesRepository as repo } from './product-categories.repository.js';
import { ProductCategoryError, type ProductCategoryListFilters } from './product-categories.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

function toResponse(category: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { products: number };
}) {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
    is_active: category.isActive,
    sort_order: category.sortOrder,
    product_count: category._count?.products ?? 0,
    created_at: category.createdAt.toISOString(),
    updated_at: category.updatedAt.toISOString(),
  };
}

interface CreateProductCategoryInput {
  code: string;
  name: string;
  description?: string;
  is_active: boolean;
  sort_order?: number;
}

interface UpdateProductCategoryInput {
  name?: string;
  description?: string;
  is_active?: boolean;
  sort_order?: number;
}

export const productCategoriesService = {
  async getAllCategories(_requestingUser: JwtPayload, filters: ProductCategoryListFilters) {
    const { categories, total } = await repo.findAll(filters);
    return { categories: categories.map(toResponse), total, page: filters.page, limit: filters.limit };
  },

  async getCategoryById(id: string) {
    const category = await repo.findById(id);
    if (!category) throw new ProductCategoryError('CATEGORY_NOT_FOUND', 'Product category not found', 404);
    return toResponse(category);
  },

  async createCategory(data: CreateProductCategoryInput, actor: ActorContext, ipAddress: string | null) {
    const existing = await repo.findByCode(data.code);
    if (existing) throw new ProductCategoryError('CATEGORY_CODE_CONFLICT', `A category with code "${data.code}" already exists`, 409);

    const category = await repo.create({
      code: data.code,
      name: data.name,
      description: data.description,
      isActive: data.is_active,
      sortOrder: data.sort_order,
      createdBy: actor.id,
    });
    const response = toResponse(category);

    await recordAuditLog({
      action: 'PRODUCT_CATEGORY_CREATED',
      entityType: 'product_category',
      entityId: category.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateCategory(id: string, data: UpdateProductCategoryInput, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findById(id);
    if (!before) throw new ProductCategoryError('CATEGORY_NOT_FOUND', 'Product category not found', 404);

    const category = await repo.update(id, {
      name: data.name,
      description: data.description,
      isActive: data.is_active,
      sortOrder: data.sort_order,
    });
    const response = toResponse(category);

    await recordAuditLog({
      action: 'PRODUCT_CATEGORY_UPDATED',
      entityType: 'product_category',
      entityId: category.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },
};
