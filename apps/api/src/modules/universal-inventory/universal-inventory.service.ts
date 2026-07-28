import { universalInventoryRepository as repo } from './universal-inventory.repository.js';
import { UniversalInventoryError } from './universal-inventory.types.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import type {
  CreateInventoryCategoryData,
  UpdateInventoryCategoryData,
  CreateUnitOfMeasureData,
  UpdateUnitOfMeasureData,
  CreateUnitConversionData,
  CreateInventoryItemData,
  UpdateInventoryItemData,
} from './universal-inventory.types.js';

type ActorContext = { id: string; role: string };

function toCategoryResponse(category: {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: category.id,
    name: category.name,
    code: category.code,
    description: category.description,
    is_active: category.isActive,
    created_at: category.createdAt.toISOString(),
    updated_at: category.updatedAt.toISOString(),
  };
}

function toUnitResponse(unit: {
  id: string;
  code: string;
  name: string;
  dimension: string;
  isBaseUnit: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name,
    dimension: unit.dimension,
    is_base_unit: unit.isBaseUnit,
    is_active: unit.isActive,
    created_at: unit.createdAt.toISOString(),
    updated_at: unit.updatedAt.toISOString(),
  };
}

function toConversionResponse(conversion: {
  id: string;
  fromUnitId: string;
  toUnitId: string;
  factor: { toNumber(): number };
  createdAt: Date;
}) {
  return {
    id: conversion.id,
    from_unit_id: conversion.fromUnitId,
    to_unit_id: conversion.toUnitId,
    factor: conversion.factor.toNumber(),
    created_at: conversion.createdAt.toISOString(),
  };
}

function toItemResponse(item: {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  baseUnitId: string;
  trackInventory: boolean;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string } | null;
  baseUnit?: { id: string; code: string; name: string };
}) {
  return {
    id: item.id,
    name: item.name,
    sku: item.sku,
    barcode: item.barcode,
    category_id: item.categoryId,
    category_name: item.category?.name ?? null,
    base_unit_id: item.baseUnitId,
    base_unit_code: item.baseUnit?.code ?? null,
    track_inventory: item.trackInventory,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}

export const universalInventoryService = {
  // --- Categories ---
  async listCategories(includeInactive: boolean) {
    const categories = await repo.listCategories(includeInactive);
    return categories.map(toCategoryResponse);
  },

  async createCategory(data: CreateInventoryCategoryData, actor: ActorContext, ipAddress: string | null) {
    const existing = await repo.findCategoryByName(data.name);
    if (existing) throw new UniversalInventoryError('CATEGORY_NAME_CONFLICT', `A category named "${data.name}" already exists`, 409);

    const category = await repo.createCategory(data);
    const response = toCategoryResponse(category);

    await recordAuditLog({
      action: 'INVENTORY_CATEGORY_CREATED',
      entityType: 'inventory_category',
      entityId: category.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateCategory(id: string, data: UpdateInventoryCategoryData, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findCategoryById(id);
    if (!before) throw new UniversalInventoryError('CATEGORY_NOT_FOUND', 'Inventory category not found', 404);

    const category = await repo.updateCategory(id, data);
    const response = toCategoryResponse(category);

    await recordAuditLog({
      action: 'INVENTORY_CATEGORY_UPDATED',
      entityType: 'inventory_category',
      entityId: category.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toCategoryResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- Units of measure ---
  async listUnits(includeInactive: boolean) {
    const units = await repo.listUnits(includeInactive);
    return units.map(toUnitResponse);
  },

  async createUnit(data: CreateUnitOfMeasureData, actor: ActorContext, ipAddress: string | null) {
    const existing = await repo.findUnitByCode(data.code);
    if (existing) throw new UniversalInventoryError('UNIT_CODE_CONFLICT', `A unit with code "${data.code}" already exists`, 409);

    const unit = await repo.createUnit(data);
    const response = toUnitResponse(unit);

    await recordAuditLog({
      action: 'UNIT_OF_MEASURE_CREATED',
      entityType: 'unit_of_measure',
      entityId: unit.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateUnit(id: string, data: UpdateUnitOfMeasureData, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findUnitById(id);
    if (!before) throw new UniversalInventoryError('UNIT_NOT_FOUND', 'Unit of measure not found', 404);

    const unit = await repo.updateUnit(id, data);
    const response = toUnitResponse(unit);

    await recordAuditLog({
      action: 'UNIT_OF_MEASURE_UPDATED',
      entityType: 'unit_of_measure',
      entityId: unit.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toUnitResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- Unit conversions ---
  async listConversions() {
    const conversions = await repo.listConversions();
    return conversions.map(toConversionResponse);
  },

  async createConversion(data: CreateUnitConversionData, actor: ActorContext, ipAddress: string | null) {
    if (data.fromUnitId === data.toUnitId) {
      throw new UniversalInventoryError('CONVERSION_SAME_UNIT', 'from_unit_id and to_unit_id must differ', 422);
    }
    const [fromUnit, toUnit] = await Promise.all([repo.findUnitById(data.fromUnitId), repo.findUnitById(data.toUnitId)]);
    if (!fromUnit || !toUnit) throw new UniversalInventoryError('UNIT_NOT_FOUND', 'from_unit_id or to_unit_id does not exist', 404);
    if (fromUnit.dimension !== toUnit.dimension) {
      throw new UniversalInventoryError('CONVERSION_DIMENSION_MISMATCH', 'Units must share the same dimension to convert between them', 422);
    }

    const existing = await repo.findConversion(data.fromUnitId, data.toUnitId);
    if (existing) throw new UniversalInventoryError('CONVERSION_ALREADY_EXISTS', 'A conversion between these units already exists', 409);

    const conversion = await repo.createConversion(data);
    const response = toConversionResponse(conversion);

    await recordAuditLog({
      action: 'UNIT_CONVERSION_CREATED',
      entityType: 'unit_conversion',
      entityId: conversion.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- Inventory items ---
  async listItems(includeInactive: boolean) {
    const items = await repo.listItems(includeInactive);
    return items.map(toItemResponse);
  },

  async getItemById(id: string) {
    const item = await repo.findItemById(id);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    const assignments = await repo.listAssignedBranches(id);
    return {
      ...toItemResponse(item),
      assigned_branches: assignments.map((a) => ({
        branch_id: a.branchId,
        branch_code: a.branch.code,
        branch_name: a.branch.name,
        city: a.branch.city,
        quantity_on_hand: a.quantityOnHand.toNumber(),
      })),
    };
  },

  async createItem(data: CreateInventoryItemData, actor: ActorContext, ipAddress: string | null) {
    const [nameConflict, unit] = await Promise.all([repo.findItemByName(data.name), repo.findUnitById(data.baseUnitId)]);
    if (nameConflict) throw new UniversalInventoryError('INVENTORY_ITEM_NAME_CONFLICT', `An inventory item named "${data.name}" already exists`, 409);
    if (!unit) throw new UniversalInventoryError('UNIT_NOT_FOUND', 'base_unit_id does not exist', 404);

    if (data.sku) {
      const skuConflict = await repo.findItemBySku(data.sku);
      if (skuConflict) throw new UniversalInventoryError('SKU_CONFLICT', `SKU "${data.sku}" is already in use`, 409);
    }
    if (data.barcode) {
      const barcodeConflict = await repo.findItemByBarcode(data.barcode);
      if (barcodeConflict) throw new UniversalInventoryError('BARCODE_CONFLICT', `Barcode "${data.barcode}" is already in use`, 409);
    }
    if (data.categoryId) {
      const category = await repo.findCategoryById(data.categoryId);
      if (!category) throw new UniversalInventoryError('CATEGORY_NOT_FOUND', 'category_id does not exist', 404);
    }

    const item = await repo.createItem(data);
    const response = toItemResponse(item);

    await recordAuditLog({
      action: 'INVENTORY_ITEM_CREATED',
      entityType: 'inventory_item',
      entityId: item.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateItem(id: string, data: UpdateInventoryItemData, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findItemById(id);
    if (!before) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    if (data.sku) {
      const skuConflict = await repo.findItemBySku(data.sku);
      if (skuConflict && skuConflict.id !== id) throw new UniversalInventoryError('SKU_CONFLICT', `SKU "${data.sku}" is already in use`, 409);
    }
    if (data.barcode) {
      const barcodeConflict = await repo.findItemByBarcode(data.barcode);
      if (barcodeConflict && barcodeConflict.id !== id) throw new UniversalInventoryError('BARCODE_CONFLICT', `Barcode "${data.barcode}" is already in use`, 409);
    }
    if (data.categoryId) {
      const category = await repo.findCategoryById(data.categoryId);
      if (!category) throw new UniversalInventoryError('CATEGORY_NOT_FOUND', 'category_id does not exist', 404);
    }

    const item = await repo.updateItem(id, data);
    const response = toItemResponse(item);

    await recordAuditLog({
      action: 'INVENTORY_ITEM_UPDATED',
      entityType: 'inventory_item',
      entityId: item.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toItemResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- Branch assignment (R2) ---
  async assignToBranches(inventoryItemId: string, branchIds: string[], actor: ActorContext, ipAddress: string | null) {
    const item = await repo.findItemById(inventoryItemId);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    const validBranchIds = new Set(await branchesRepository.listAllBranchIds());
    const unknown = branchIds.filter((id) => !validBranchIds.has(id));
    if (unknown.length > 0) {
      throw new UniversalInventoryError('BRANCH_NOT_FOUND', `Unknown branch_id(s): ${unknown.join(', ')}`, 404);
    }

    const created: { branchId: string }[] = [];
    const alreadyAssigned: string[] = [];
    for (const branchId of branchIds) {
      const existing = await repo.findAssignment(branchId, inventoryItemId);
      if (existing) {
        alreadyAssigned.push(branchId);
        continue;
      }
      await repo.assignToBranch(branchId, inventoryItemId);
      created.push({ branchId });
    }

    await recordAuditLog({
      action: 'INVENTORY_ITEM_BRANCH_ASSIGNED',
      entityType: 'inventory_stock',
      entityId: inventoryItemId,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: { inventory_item_id: inventoryItemId, assigned: created.map((c) => c.branchId), already_assigned: alreadyAssigned },
      ipAddress,
    });

    return { assigned: created.map((c) => c.branchId), already_assigned: alreadyAssigned };
  },
};
