import { productComponentsRepository as repo } from './product-components.repository.js';
import { ProductComponentError } from './product-components.types.js';
import { universalInventoryRepository } from '../universal-inventory/universal-inventory.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import type { CreateProductComponentData, UpdateProductComponentData } from './product-components.types.js';

type ActorContext = { id: string; role: string };

function toResponse(component: {
  id: string;
  productVariantId: string;
  inventoryItemId: string;
  quantityRequired: { toNumber(): number };
  version: number;
  createdAt: Date;
  updatedAt: Date;
  inventoryItem: { id: string; name: string; sku: string | null; baseUnit: { code: string } };
}) {
  return {
    id: component.id,
    product_variant_id: component.productVariantId,
    inventory_item_id: component.inventoryItemId,
    inventory_item_name: component.inventoryItem.name,
    inventory_item_sku: component.inventoryItem.sku,
    base_unit_code: component.inventoryItem.baseUnit.code,
    quantity_required: component.quantityRequired.toNumber(),
    version: component.version,
    created_at: component.createdAt.toISOString(),
    updated_at: component.updatedAt.toISOString(),
  };
}

export const productComponentsService = {
  async listByVariant(productVariantId: string) {
    const components = await repo.findByVariant(productVariantId);
    return components.map(toResponse);
  },

  async createMapping(data: CreateProductComponentData, actor: ActorContext, ipAddress: string | null) {
    const item = await universalInventoryRepository.findItemById(data.inventoryItemId);
    if (!item) throw new ProductComponentError('INVENTORY_ITEM_NOT_FOUND', 'inventory_item_id does not exist', 404);

    const existing = await repo.findByVariantAndItem(data.productVariantId, data.inventoryItemId);
    if (existing) throw new ProductComponentError('MAPPING_ALREADY_EXISTS', 'This inventory item is already mapped to this variant', 409);

    const component = await repo.create(data);
    const response = toResponse(component);

    await recordAuditLog({
      action: 'PRODUCT_COMPONENT_CREATED',
      entityType: 'product_component',
      entityId: component.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateMapping(id: string, data: UpdateProductComponentData, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findById(id);
    if (!before) throw new ProductComponentError('MAPPING_NOT_FOUND', 'Product component mapping not found', 404);

    const component = await repo.update(id, data);
    const response = toResponse(component);

    await recordAuditLog({
      action: 'PRODUCT_COMPONENT_UPDATED',
      entityType: 'product_component',
      entityId: component.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteMapping(id: string, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findById(id);
    if (!before) throw new ProductComponentError('MAPPING_NOT_FOUND', 'Product component mapping not found', 404);

    await repo.delete(id, actor.id);

    await recordAuditLog({
      action: 'PRODUCT_COMPONENT_DELETED',
      entityType: 'product_component',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(before),
      ipAddress,
    });
  },
};
