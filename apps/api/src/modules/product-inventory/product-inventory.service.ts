import { Prisma } from '@prisma/client';
import { productInventoryRepository } from './product-inventory.repository.js';
import { ProductInventoryError } from './product-inventory.types.js';
import { productsRepository } from '../products/products.repository.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
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
  async listByVariant(productVariantId: string) {
    const rows = (await productInventoryRepository.findByVariant(productVariantId)) as ProductInventoryRow[];
    return rows.map(toResponse);
  },

  async createMapping(data: CreateProductInventoryInput, actor: ActorContext, ipAddress: string | null) {
    const variant = await productsRepository.findVariantById(data.product_variant_id);
    if (!variant) throw new ProductInventoryError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    const ingredient = await inventoryRepository.findIngredientById(data.ingredient_id);
    if (!ingredient) throw new ProductInventoryError('INGREDIENT_NOT_FOUND', 'Inventory item not found', 404);

    const existing = await productInventoryRepository.findByVariantAndIngredient(data.product_variant_id, data.ingredient_id);
    if (existing) throw mappingExistsError();

    let created: ProductInventoryRow;
    try {
      created = (await productInventoryRepository.create({
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

  async updateMapping(id: string, data: UpdateProductInventoryInput, actor: ActorContext, ipAddress: string | null) {
    const existing = (await productInventoryRepository.findById(id)) as ProductInventoryRow | null;
    if (!existing) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const updated = (await productInventoryRepository.update(id, {
      quantityRequired: data.quantity_required,
      unit: data.unit,
    })) as ProductInventoryRow;
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

  async deleteMapping(id: string, actor: ActorContext, ipAddress: string | null) {
    const existing = (await productInventoryRepository.findById(id)) as ProductInventoryRow | null;
    if (!existing) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    await productInventoryRepository.delete(id);

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
