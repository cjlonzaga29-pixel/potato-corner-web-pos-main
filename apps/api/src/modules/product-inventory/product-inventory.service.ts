import { Prisma } from '@prisma/client';
import { productInventoryRepository } from './product-inventory.repository.js';
import { ProductInventoryError } from './product-inventory.types.js';
import { productsRepository } from '../products/products.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

interface ProductInventoryRow {
  id: string;
  productVariantId: string;
  ingredientId: string;
  quantityRequired: { toNumber(): number };
  unit: string;
  createdAt: Date;
  updatedAt: Date;
  ingredient: { name: string };
}

function toResponse(row: ProductInventoryRow) {
  return {
    id: row.id,
    product_variant_id: row.productVariantId,
    ingredient_id: row.ingredientId,
    ingredient_name: row.ingredient.name,
    quantity_required: row.quantityRequired.toNumber(),
    unit: row.unit,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface CreateProductInventoryInput {
  branch_id: string;
  product_variant_id: string;
  ingredient_id: string;
  quantity_required: number;
  unit: string;
}

interface UpdateProductInventoryInput {
  quantity_required?: number;
  unit?: string;
}

function mappingExistsError(): ProductInventoryError {
  return new ProductInventoryError(
    'PRODUCT_INVENTORY_MAPPING_EXISTS',
    'A mapping for this product variant and inventory item already exists',
    409,
  );
}

export const productInventoryService = {
  async listByVariant(branchId: string, productVariantId: string) {
    const rows = (await productInventoryRepository.findByVariant(branchId, productVariantId)) as ProductInventoryRow[];
    return rows.map(toResponse);
  },

  /**
   * branchIds ('all' for super_admin, else the caller's allowed branch_ids —
   * see lib/branch-access.ts) gates data.branch_id itself before anything is
   * looked up, and the ingredient is then resolved scoped to that same
   * branch_id so a cross-branch ingredient never passes as a valid mapping
   * target — mirrors updateMapping/deleteMapping's branch-scoping.
   */
  async createMapping(data: CreateProductInventoryInput, branchIds: string[] | 'all', actor: ActorContext, ipAddress: string | null) {
    if (branchIds !== 'all' && !branchIds.includes(data.branch_id)) {
      throw new ProductInventoryError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
    }

    const variant = await productsRepository.findVariantById(data.product_variant_id);
    if (!variant) throw new ProductInventoryError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    const ingredient = await productInventoryRepository.findIngredientForBranch(data.ingredient_id, data.branch_id);
    if (!ingredient) throw new ProductInventoryError('INGREDIENT_NOT_FOUND', 'Inventory item not found', 404);

    const existing = await productInventoryRepository.findByVariantAndIngredient(data.branch_id, data.product_variant_id, data.ingredient_id);
    if (existing) throw mappingExistsError();

    let created: ProductInventoryRow;
    try {
      created = (await productInventoryRepository.create({
        branchId: data.branch_id,
        productVariantId: data.product_variant_id,
        ingredientId: data.ingredient_id,
        quantityRequired: data.quantity_required,
        unit: data.unit,
      })) as ProductInventoryRow;
    } catch (error) {
      // Belt-and-suspenders against the findByVariantAndIngredient check
      // above racing a concurrent create — @@unique([productVariantId,
      // ingredientId]) in schema.prisma is the actual guarantee.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw mappingExistsError();
      }
      throw error;
    }
    const response = toResponse(created);

    await recordAuditLog({
      action: 'PRODUCT_INVENTORY_CREATED',
      entityType: 'product_inventory',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  /**
   * branchIds ('all' for super_admin, else the caller's allowed branch_ids —
   * see lib/branch-access.ts) scopes both the existence check and the write
   * itself, so a mapping owned by another branch behaves as not found rather
   * than revealing it exists elsewhere.
   */
  async updateMapping(id: string, data: UpdateProductInventoryInput, branchIds: string[] | 'all', actor: ActorContext, ipAddress: string | null) {
    const existing = (await productInventoryRepository.findById(id, branchIds)) as ProductInventoryRow | null;
    if (!existing) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const result = await productInventoryRepository.update(
      id,
      {
        quantityRequired: data.quantity_required,
        unit: data.unit,
      },
      branchIds,
    );
    if (result.count === 0) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const updated = (await productInventoryRepository.findById(id, branchIds)) as ProductInventoryRow;
    const response = toResponse(updated);

    await recordAuditLog({
      action: 'PRODUCT_INVENTORY_UPDATED',
      entityType: 'product_inventory',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteMapping(id: string, branchIds: string[] | 'all', actor: ActorContext, ipAddress: string | null) {
    const existing = (await productInventoryRepository.findById(id, branchIds)) as ProductInventoryRow | null;
    if (!existing) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const result = await productInventoryRepository.delete(id, branchIds, actor.id);
    if (result.count === 0) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    await recordAuditLog({
      action: 'PRODUCT_INVENTORY_DELETED',
      entityType: 'product_inventory',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(existing),
      ipAddress,
    });
  },
};
