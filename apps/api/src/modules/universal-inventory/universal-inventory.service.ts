import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { universalInventoryRepository as repo } from './universal-inventory.repository.js';
import { UniversalInventoryError } from './universal-inventory.types.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';
import { enqueueRawNotificationJob } from '../../queues/notification.queue.js';
import { convertQuantity } from '../product-components/unit-conversion.util.js';
import { dayBounds } from '../../lib/manila-time.js';
import { blendWeightedAverageCost } from '../../lib/inventory-cost.js';
import { getTransferDestinationBranchIds } from '../../lib/branch-access.js';
import type {
  CreateInventoryCategoryData,
  UpdateInventoryCategoryData,
  CreateUnitOfMeasureData,
  UpdateUnitOfMeasureData,
  CreateUnitConversionData,
  CreateInventoryItemUnitConversionData,
  UpdateInventoryItemUnitConversionData,
  CreateInventoryItemData,
  UpdateInventoryItemData,
  ReceiveInventoryStockData,
  AdjustInventoryStockData,
  WasteInventoryStockData,
  TransferInventoryStockData,
  PhysicalCountInventoryStockData,
  InventoryStockMovementType,
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

function toItemConversionResponse(conversion: {
  id: string;
  inventoryItemId: string;
  fromUnitId: string;
  toUnitId: string;
  factor: { toNumber(): number };
  createdAt: Date;
  updatedAt: Date;
  fromUnit: { code: string; name: string };
  toUnit: { code: string; name: string };
}) {
  return {
    id: conversion.id,
    inventory_item_id: conversion.inventoryItemId,
    from_unit_id: conversion.fromUnitId,
    from_unit_code: conversion.fromUnit.code,
    from_unit_name: conversion.fromUnit.name,
    to_unit_id: conversion.toUnitId,
    to_unit_code: conversion.toUnit.code,
    to_unit_name: conversion.toUnit.name,
    factor: conversion.factor.toNumber(),
    created_at: conversion.createdAt.toISOString(),
    updated_at: conversion.updatedAt.toISOString(),
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

// ---------------------------------------------------------------------------
// Branch inventory cutover — direct InventoryStock operations (brief §1-9).
// ---------------------------------------------------------------------------

interface StockMovementRow {
  id: string;
  branchId: string;
  inventoryItemId: string;
  inventoryItem: { name: string };
  movementType: string;
  quantityChange: { toNumber(): number };
  quantityBefore: { toNumber(): number };
  quantityAfter: { toNumber(): number };
  unitId: string | null;
  unit: { code: string } | null;
  referenceType: string | null;
  referenceId: string | null;
  notes: string | null;
  performedByUserId: string | null;
  unitCost: { toNumber(): number } | null;
  totalCost: { toNumber(): number } | null;
  responsibleUserId: string | null;
  createdAt: Date;
}

function toStockMovementResponse(row: StockMovementRow) {
  return {
    id: row.id,
    branch_id: row.branchId,
    inventory_item_id: row.inventoryItemId,
    inventory_item_name: row.inventoryItem.name,
    movement_type: row.movementType,
    quantity_change: row.quantityChange.toNumber(),
    quantity_before: row.quantityBefore.toNumber(),
    quantity_after: row.quantityAfter.toNumber(),
    unit_id: row.unitId,
    unit_code: row.unit?.code ?? null,
    reference_type: row.referenceType,
    reference_id: row.referenceId,
    notes: row.notes,
    performed_by_user_id: row.performedByUserId,
    unit_cost: row.unitCost?.toNumber() ?? null,
    total_cost: row.totalCost?.toNumber() ?? null,
    responsible_user_id: row.responsibleUserId,
    created_at: row.createdAt.toISOString(),
  };
}

/** Mirrors legacy inventory.service.ts's classifyStatus, but "healthy" (not "ok") per the brief's own wording, and threshold-null-safe since InventoryStock thresholds are nullable (brief §8). Exported so other InventoryStock-sourced reports (e.g. reports.repository.ts's valuation rollup) reuse the same rule instead of duplicating it. */
export function classifyStockStatus(quantityOnHand: number, lowThreshold: number | null, criticalThreshold: number | null): 'healthy' | 'low' | 'critical' {
  if (criticalThreshold !== null && quantityOnHand <= criticalThreshold) return 'critical';
  if (lowThreshold !== null && quantityOnHand <= lowThreshold) return 'low';
  return 'healthy';
}

interface StockRow {
  inventoryItemId: string;
  quantityOnHand: { toNumber(): number };
  lowStockThreshold: { toNumber(): number } | null;
  criticalThreshold: { toNumber(): number } | null;
  unitCost: { toNumber(): number } | null;
  inventoryItem: {
    name: string;
    sku: string | null;
    category?: { name: string } | null;
    baseUnit: { code: string };
    unitCost: { toNumber(): number } | null;
  };
}

function toStockRowResponse(row: StockRow) {
  const quantity = row.quantityOnHand.toNumber();
  const lowThreshold = row.lowStockThreshold?.toNumber() ?? null;
  const criticalThreshold = row.criticalThreshold?.toNumber() ?? null;
  // Branch-specific InventoryStock.unitCost overrides InventoryItem.unitCost
  // (the item-level default) — null means "cost not initialized", never 0.
  const avgUnitCost = row.unitCost?.toNumber() ?? row.inventoryItem.unitCost?.toNumber() ?? null;
  return {
    inventory_item_id: row.inventoryItemId,
    name: row.inventoryItem.name,
    sku: row.inventoryItem.sku,
    category_name: row.inventoryItem.category?.name ?? null,
    base_unit_code: row.inventoryItem.baseUnit.code,
    quantity_on_hand: quantity,
    low_stock_threshold: lowThreshold,
    critical_threshold: criticalThreshold,
    status: classifyStockStatus(quantity, lowThreshold, criticalThreshold),
    avg_unit_cost: avgUnitCost,
    inventory_value: avgUnitCost !== null ? Math.round(avgUnitCost * quantity * 100) / 100 : null,
  };
}

/** Same low_stock_alert job the legacy path enqueues — fire-and-forget, never fails an already-committed movement. Null threshold means "no alerting configured for this item/branch", not "always alert". */
async function notifyIfLowStock(params: {
  branchId: string;
  inventoryItemId: string;
  itemName: string;
  quantityAfter: number;
  lowStockThreshold: number | null;
  criticalThreshold: number | null;
}): Promise<void> {
  if (params.lowStockThreshold === null || params.quantityAfter > params.lowStockThreshold) return;
  try {
    await enqueueRawNotificationJob('low_stock_alert', {
      branchId: params.branchId,
      inventoryItemId: params.inventoryItemId,
      itemName: params.itemName,
      currentStock: params.quantityAfter,
      lowStockThreshold: params.lowStockThreshold,
      criticalThreshold: params.criticalThreshold,
      severity: params.criticalThreshold !== null && params.quantityAfter <= params.criticalThreshold ? 'critical' : 'low',
    });
  } catch (error) {
    console.error(`Failed to enqueue low-stock alert for inventory item ${params.inventoryItemId}:`, error);
  }
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

  // --- Item-specific unit conversions (TASK 115) ---
  // Dimension is intentionally not checked here (unlike createConversion):
  // item-specific rows exist precisely to encode density conversions across
  // dimensions (e.g. tbsp[VOLUME] -> g[WEIGHT] for a given ingredient), so
  // requiring matching dimensions would defeat the feature.

  async listItemConversions(inventoryItemId: string) {
    const item = await repo.findItemById(inventoryItemId);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    const conversions = await repo.listItemConversions(inventoryItemId);
    return conversions.map(toItemConversionResponse);
  },

  async createItemConversion(data: CreateInventoryItemUnitConversionData, actor: ActorContext, ipAddress: string | null) {
    if (data.fromUnitId === data.toUnitId) {
      throw new UniversalInventoryError('CONVERSION_SAME_UNIT', 'from_unit_id and to_unit_id must differ', 422);
    }
    if (!(data.factor > 0)) {
      throw new UniversalInventoryError('CONVERSION_FACTOR_INVALID', 'factor must be greater than zero', 422);
    }

    const item = await repo.findItemById(data.inventoryItemId);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    const [fromUnit, toUnit] = await Promise.all([repo.findUnitById(data.fromUnitId), repo.findUnitById(data.toUnitId)]);
    if (!fromUnit || !toUnit) throw new UniversalInventoryError('UNIT_NOT_FOUND', 'from_unit_id or to_unit_id does not exist', 404);
    if (!fromUnit.isActive || !toUnit.isActive) {
      throw new UniversalInventoryError('UNIT_INACTIVE', 'from_unit_id and to_unit_id must both be active', 422);
    }

    const existing = await repo.findItemConversion(data.inventoryItemId, data.fromUnitId, data.toUnitId);
    if (existing) {
      throw new UniversalInventoryError('ITEM_CONVERSION_ALREADY_EXISTS', 'A conversion between these units already exists for this item', 409);
    }

    const conversion = await repo.createItemConversion(data);
    const response = toItemConversionResponse(conversion);

    await recordAuditLog({
      action: 'INVENTORY_ITEM_UNIT_CONVERSION_CREATED',
      entityType: 'inventory_item_unit_conversion',
      entityId: conversion.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateItemConversion(
    inventoryItemId: string,
    id: string,
    data: UpdateInventoryItemUnitConversionData,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    if (!(data.factor > 0)) {
      throw new UniversalInventoryError('CONVERSION_FACTOR_INVALID', 'factor must be greater than zero', 422);
    }

    const before = await repo.findItemConversionById(id);
    if (!before || before.inventoryItemId !== inventoryItemId) {
      throw new UniversalInventoryError('ITEM_CONVERSION_NOT_FOUND', 'Inventory item unit conversion not found', 404);
    }

    const conversion = await repo.updateItemConversion(id, data);
    const response = toItemConversionResponse(conversion);

    await recordAuditLog({
      action: 'INVENTORY_ITEM_UNIT_CONVERSION_UPDATED',
      entityType: 'inventory_item_unit_conversion',
      entityId: conversion.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toItemConversionResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteItemConversion(inventoryItemId: string, id: string, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findItemConversionById(id);
    if (!before || before.inventoryItemId !== inventoryItemId) {
      throw new UniversalInventoryError('ITEM_CONVERSION_NOT_FOUND', 'Inventory item unit conversion not found', 404);
    }

    await repo.deleteItemConversion(id);

    await recordAuditLog({
      action: 'INVENTORY_ITEM_UNIT_CONVERSION_DELETED',
      entityType: 'inventory_item_unit_conversion',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toItemConversionResponse(before),
      ipAddress,
    });

    return { id };
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

    const activeBranchIds = await branchesRepository.listAllBranchIds();
    if (activeBranchIds.length > 0) {
      await this.provisionItemAcrossBranches(item.id, activeBranchIds);
    }

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

  /**
   * Fan-out for new branches: every active, tracked InventoryItem gets a
   * zero-stock InventoryStock row in the new branch. Mirrors
   * inventoryService.provisionBranchIngredients for the legacy model.
   * Idempotent via skipDuplicates — safe to re-run.
   */
  async provisionBranchStock(branchId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const items = await repo.listActiveTrackedItemIds(tx);
    if (items.length === 0) return;
    await repo.createStockRows(
      items.map((item) => ({ branchId, inventoryItemId: item.id })),
      tx,
    );
  },

  /**
   * Fan-out for new items: the given InventoryItem gets a zero-stock
   * InventoryStock row in every listed branch. Idempotent via skipDuplicates.
   */
  async provisionItemAcrossBranches(inventoryItemId: string, branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) return;
    await repo.createStockRows(branchIds.map((branchId) => ({ branchId, inventoryItemId })));
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

  // --- Branch inventory list, alerts, movement history (brief §2, §8) ---

  async getBranchStock(branchId: string) {
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const { dayStart, dayEnd } = dayBounds(new Date());
    const [rows, consumedTodayByItem] = await Promise.all([
      repo.findBranchStockRows(branchId),
      repo.getConsumedTodayByBranch(branchId, dayStart, dayEnd),
    ]);
    return {
      branch_id: branchId,
      items: rows.map((row) => ({
        ...toStockRowResponse(row),
        consumed_today: Math.round((consumedTodayByItem.get(row.inventoryItemId) ?? 0) * 100) / 100,
      })),
    };
  },

  async getBranchStockAlerts(branchId: string) {
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const rows = (await repo.findBranchStockRows(branchId)).map(toStockRowResponse);
    const alerts = rows
      .filter((r) => r.status !== 'healthy')
      .map((r) => ({
        inventory_item_id: r.inventory_item_id,
        name: r.name,
        quantity_on_hand: r.quantity_on_hand,
        threshold: r.status === 'critical' ? (r.critical_threshold ?? 0) : (r.low_stock_threshold ?? 0),
        severity: r.status as 'low' | 'critical',
      }));
    return { branch_id: branchId, alerts };
  },

  async getStockMovements(
    branchId: string,
    filters: { inventoryItemId?: string; movementType?: InventoryStockMovementType; fromDate?: Date; toDate?: Date; page: number; limit: number },
  ) {
    const { movements, total } = await repo.findStockMovements(branchId, filters);
    return {
      movements: movements.map(toStockMovementResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  // --- Direct receiving / stock-in (brief §3) ---

  async receiveStock(data: ReceiveInventoryStockData, actor: ActorContext, ipAddress: string | null) {
    const [branch, item] = await Promise.all([branchesRepository.findById(data.branchId), repo.findItemById(data.inventoryItemId)]);
    if (!branch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    const baseQuantity = await convertQuantity(data.quantity, data.enteredUnitId ?? item.baseUnitId, item.baseUnitId, item.id);
    // unit_cost is entered per the form's unit (e.g. per gram), same as
    // quantity — convert the base-quantity cost basis consistently so
    // unitCost always means "per base unit" everywhere it's stored/read.
    const unitCostPerBaseUnit = new Prisma.Decimal(data.unitCost).mul(new Prisma.Decimal(data.quantity)).div(baseQuantity);
    const totalCost = unitCostPerBaseUnit.mul(baseQuantity);

    const movement = await prisma.$transaction(async (tx) => {
      const stock = await repo.lockAndGetStock(data.branchId, data.inventoryItemId, tx);
      if (!stock) {
        throw new UniversalInventoryError('STOCK_ROW_NOT_FOUND', 'No InventoryStock row exists for this branch/item — provisioning has not completed', 404);
      }
      const quantityBefore = stock.quantityOnHand;
      const newAverageCost = blendWeightedAverageCost(quantityBefore, stock.unitCost, baseQuantity, unitCostPerBaseUnit);
      const updated = await repo.incrementStockQuantity(data.branchId, data.inventoryItemId, baseQuantity, tx, newAverageCost);
      const quantityAfter = updated.quantityOnHand;
      return repo.createStockMovement(
        {
          branchId: data.branchId,
          inventoryItemId: data.inventoryItemId,
          movementType: 'RECEIVING',
          quantityChange: baseQuantity,
          quantityBefore,
          quantityAfter,
          unitId: item.baseUnitId,
          referenceType: data.deliveryReference ? 'delivery' : undefined,
          referenceId: data.deliveryReference,
          notes: data.notes,
          performedByUserId: data.performedByUserId ?? actor.id,
          unitCost: unitCostPerBaseUnit,
          totalCost,
        },
        tx,
      );
    });

    const response = toStockMovementResponse(movement);

    await recordAuditLog({
      action: 'INVENTORY_STOCK_RECEIVED',
      entityType: 'inventory_stock_movement',
      entityId: movement.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    return response;
  },

  // --- Stock adjustment (brief §4) ---

  async adjustStock(data: AdjustInventoryStockData, actor: ActorContext, ipAddress: string | null) {
    const [branch, item] = await Promise.all([branchesRepository.findById(data.branchId), repo.findItemById(data.inventoryItemId)]);
    if (!branch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    const movement = await prisma.$transaction(async (tx) => {
      const stock = await repo.lockAndGetStock(data.branchId, data.inventoryItemId, tx);
      if (!stock) {
        throw new UniversalInventoryError('STOCK_ROW_NOT_FOUND', 'No InventoryStock row exists for this branch/item — provisioning has not completed', 404);
      }
      const quantityBefore = stock.quantityOnHand;
      // Validated against the locked read before writing — the advisory lock
      // held since lockAndGetStock guarantees no concurrent writer can move
      // this row between this check and the atomic increment below, so the
      // projected value is exact, not just an estimate.
      if (quantityBefore.plus(data.quantityDelta).lessThan(0)) {
        throw new UniversalInventoryError('INSUFFICIENT_STOCK', 'Adjustment would take stock below zero', 409);
      }
      const updated = await repo.incrementStockQuantity(data.branchId, data.inventoryItemId, data.quantityDelta, tx);
      const quantityAfter = updated.quantityOnHand;
      return repo.createStockMovement(
        {
          branchId: data.branchId,
          inventoryItemId: data.inventoryItemId,
          movementType: data.quantityDelta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
          quantityChange: data.quantityDelta,
          quantityBefore,
          quantityAfter,
          unitId: item.baseUnitId,
          notes: `Reason: ${data.reasonCode}${data.notes ? ` — ${data.notes}` : ''}`,
          performedByUserId: data.performedByUserId ?? actor.id,
        },
        tx,
      );
    });

    const response = toStockMovementResponse(movement);

    await recordAuditLog({
      action: 'INVENTORY_STOCK_ADJUSTED',
      entityType: 'inventory_stock_movement',
      entityId: movement.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    const stockAfter = await repo.findStock(data.branchId, data.inventoryItemId);
    await notifyIfLowStock({
      branchId: data.branchId,
      inventoryItemId: data.inventoryItemId,
      itemName: item.name,
      quantityAfter: movement.quantityAfter.toNumber(),
      lowStockThreshold: stockAfter?.lowStockThreshold?.toNumber() ?? null,
      criticalThreshold: stockAfter?.criticalThreshold?.toNumber() ?? null,
    });

    return response;
  },

  // --- Waste management (brief §5) ---

  async wasteStock(data: WasteInventoryStockData, actor: ActorContext, ipAddress: string | null) {
    const [branch, item] = await Promise.all([branchesRepository.findById(data.branchId), repo.findItemById(data.inventoryItemId)]);
    if (!branch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    // Responsible Staff must be an active user actually assigned to this
    // branch — never let a caller attribute waste to someone in another
    // branch (or a deactivated account).
    const responsibleUserValid = await repo.isActiveUserInBranch(data.responsibleUserId, data.branchId);
    if (!responsibleUserValid) {
      throw new UniversalInventoryError('INVALID_RESPONSIBLE_USER', 'Responsible staff must be an active user assigned to this branch', 400);
    }

    const baseQuantity = await convertQuantity(data.quantity, data.enteredUnitId ?? item.baseUnitId, item.baseUnitId, item.id);

    const movement = await prisma.$transaction(async (tx) => {
      const stock = await repo.lockAndGetStock(data.branchId, data.inventoryItemId, tx);
      if (!stock) {
        throw new UniversalInventoryError('STOCK_ROW_NOT_FOUND', 'No InventoryStock row exists for this branch/item — provisioning has not completed', 404);
      }
      const quantityBefore = stock.quantityOnHand;
      // Same locked-read-then-atomic-write reasoning as adjustStock above.
      if (quantityBefore.minus(baseQuantity).lessThan(0)) {
        throw new UniversalInventoryError('INSUFFICIENT_STOCK', 'Waste quantity exceeds current stock', 409);
      }
      // Waste consumes at the current carrying cost — it never changes the
      // average (unlike receiving), so the cost argument to
      // incrementStockQuantity is deliberately omitted. If cost was never
      // initialized for this item, unitCost/totalCost stay null (never a
      // fabricated 0) rather than under-reporting waste loss as free.
      const unitCost = stock.unitCost;
      const totalCost = unitCost ? unitCost.mul(baseQuantity) : null;
      const updated = await repo.incrementStockQuantity(data.branchId, data.inventoryItemId, baseQuantity.negated(), tx);
      const quantityAfter = updated.quantityOnHand;
      return repo.createStockMovement(
        {
          branchId: data.branchId,
          inventoryItemId: data.inventoryItemId,
          movementType: 'WASTE',
          quantityChange: baseQuantity.negated(),
          quantityBefore,
          quantityAfter,
          unitId: item.baseUnitId,
          notes: `Reason: ${data.reasonCode}${data.notes ? ` — ${data.notes}` : ''}`,
          performedByUserId: data.performedByUserId ?? actor.id,
          responsibleUserId: data.responsibleUserId,
          unitCost: unitCost ?? undefined,
          totalCost: totalCost ?? undefined,
        },
        tx,
      );
    });

    const response = toStockMovementResponse(movement);

    await recordAuditLog({
      action: 'INVENTORY_WASTE_RECORDED',
      entityType: 'inventory_stock_movement',
      entityId: movement.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    const stockAfter = await repo.findStock(data.branchId, data.inventoryItemId);
    await notifyIfLowStock({
      branchId: data.branchId,
      inventoryItemId: data.inventoryItemId,
      itemName: item.name,
      quantityAfter: movement.quantityAfter.toNumber(),
      lowStockThreshold: stockAfter?.lowStockThreshold?.toNumber() ?? null,
      criticalThreshold: stockAfter?.criticalThreshold?.toNumber() ?? null,
    });

    return response;
  },

  // --- Branch transfers (brief §6) ---

  async transferStock(data: TransferInventoryStockData, actor: ActorContext, ipAddress: string | null) {
    if (data.fromBranchId === data.toBranchId) {
      throw new UniversalInventoryError('INVALID_TRANSFER', 'Cannot transfer stock to the same branch', 422);
    }

    const [fromBranch, toBranch, item] = await Promise.all([
      branchesRepository.findById(data.fromBranchId),
      branchesRepository.findById(data.toBranchId),
      repo.findItemById(data.inventoryItemId),
    ]);
    if (!fromBranch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Source branch not found', 404);
    if (!toBranch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Destination branch not found', 404);
    if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found', 404);

    // Transfer RBAC policy. Source-branch authorization (own branch for a
    // branch account, an assigned active branch for a supervisor) is already
    // enforced by branchGuard on the route (req.params.branchId) before this
    // service method is ever reached — that also blocks a branch account
    // from spoofing its source branch. Destination authorization has no
    // equivalent route-level guard (to_branch_id is a body field, not a
    // route param), so it's enforced here instead, directly against the
    // database — never trusting that the frontend only offered authorized
    // options, since this same code path is what a direct API call reaches.
    if (toBranch.status !== 'active') {
      throw new UniversalInventoryError('BRANCH_INACTIVE', 'Destination branch is not active', 422);
    }
    const authorizedDestinations = await getTransferDestinationBranchIds(actor);
    if (authorizedDestinations !== 'all' && !authorizedDestinations.includes(data.toBranchId)) {
      throw new UniversalInventoryError('TRANSFER_DESTINATION_DENIED', 'You are not authorized to transfer stock to this branch', 403);
    }

    const transferId = randomUUID();

    const { transferOut, transferIn } = await prisma.$transaction(async (tx) => {
      // Lock both (branch, item) rows in a globally consistent order (by
      // branchId) so two concurrent transfers of the same item in opposite
      // directions between the same two branches can never deadlock.
      const firstBranchId = data.fromBranchId < data.toBranchId ? data.fromBranchId : data.toBranchId;
      const secondBranchId = data.fromBranchId < data.toBranchId ? data.toBranchId : data.fromBranchId;
      const firstStock = await repo.lockAndGetStock(firstBranchId, data.inventoryItemId, tx);
      const secondStock = await repo.lockAndGetStock(secondBranchId, data.inventoryItemId, tx);
      const sourceStock = firstBranchId === data.fromBranchId ? firstStock : secondStock;
      const destStock = firstBranchId === data.fromBranchId ? secondStock : firstStock;

      if (!sourceStock) {
        throw new UniversalInventoryError('STOCK_ROW_NOT_FOUND', 'No InventoryStock row exists for the source branch/item', 404);
      }
      if (!destStock) {
        throw new UniversalInventoryError('STOCK_ROW_NOT_FOUND', 'No InventoryStock row exists for the destination branch/item', 404);
      }

      const outBefore = sourceStock.quantityOnHand;
      // Same locked-read-then-atomic-write reasoning as adjustStock above.
      if (outBefore.minus(data.quantity).lessThan(0)) {
        throw new UniversalInventoryError('INSUFFICIENT_STOCK', 'Transfer quantity exceeds current stock at the source branch', 409);
      }
      const inBefore = destStock.quantityOnHand;

      // Transfer preserves cost basis — it's neither a sale (no COGS) nor a
      // purchase/expense. The source's own average cost is untouched (only
      // its quantity drops); the transferred value is carried at the
      // source's current average and blended into the destination's average
      // the same way a costed receiving would be. If the source cost is
      // unknown (null — never costed), there's nothing to carry or blend,
      // so both movements' cost snapshots stay null rather than fabricating
      // one.
      const transferUnitCost = sourceStock.unitCost;
      const transferTotalCost = transferUnitCost ? transferUnitCost.mul(data.quantity) : null;
      const newDestAvgCost = transferUnitCost
        ? blendWeightedAverageCost(inBefore, destStock.unitCost, new Prisma.Decimal(data.quantity), transferUnitCost)
        : undefined;

      const updatedSource = await repo.incrementStockQuantity(data.fromBranchId, data.inventoryItemId, -data.quantity, tx);
      const updatedDest = await repo.incrementStockQuantity(data.toBranchId, data.inventoryItemId, data.quantity, tx, newDestAvgCost);
      const outAfter = updatedSource.quantityOnHand;
      const inAfter = updatedDest.quantityOnHand;

      const out = await repo.createStockMovement(
        {
          branchId: data.fromBranchId,
          inventoryItemId: data.inventoryItemId,
          movementType: 'TRANSFER_OUT',
          quantityChange: new Prisma.Decimal(data.quantity).negated(),
          quantityBefore: outBefore,
          quantityAfter: outAfter,
          unitId: item.baseUnitId,
          referenceType: 'transfer',
          referenceId: transferId,
          notes: data.notes,
          performedByUserId: data.performedByUserId ?? actor.id,
          unitCost: transferUnitCost ?? undefined,
          totalCost: transferTotalCost ?? undefined,
        },
        tx,
      );
      const inMovement = await repo.createStockMovement(
        {
          branchId: data.toBranchId,
          inventoryItemId: data.inventoryItemId,
          movementType: 'TRANSFER_IN',
          quantityChange: data.quantity,
          quantityBefore: inBefore,
          quantityAfter: inAfter,
          unitId: item.baseUnitId,
          referenceType: 'transfer',
          referenceId: transferId,
          notes: data.notes,
          performedByUserId: data.performedByUserId ?? actor.id,
          unitCost: transferUnitCost ?? undefined,
          totalCost: transferTotalCost ?? undefined,
        },
        tx,
      );

      return { transferOut: out, transferIn: inMovement };
    });

    const response = {
      inventory_item_id: data.inventoryItemId,
      to_branch_id: data.toBranchId,
      quantity: data.quantity,
      transfer_out: toStockMovementResponse(transferOut),
      transfer_in: toStockMovementResponse(transferIn),
    };

    await recordAuditLog({
      action: 'INVENTORY_STOCK_TRANSFERRED',
      entityType: 'inventory_stock_movement',
      entityId: transferOut.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.fromBranchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.fromBranchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifyBranch(data.toBranchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    const [sourceStockAfter, destStockAfter] = await Promise.all([
      repo.findStock(data.fromBranchId, data.inventoryItemId),
      repo.findStock(data.toBranchId, data.inventoryItemId),
    ]);
    await notifyIfLowStock({
      branchId: data.fromBranchId,
      inventoryItemId: data.inventoryItemId,
      itemName: item.name,
      quantityAfter: transferOut.quantityAfter.toNumber(),
      lowStockThreshold: sourceStockAfter?.lowStockThreshold?.toNumber() ?? null,
      criticalThreshold: sourceStockAfter?.criticalThreshold?.toNumber() ?? null,
    });
    await notifyIfLowStock({
      branchId: data.toBranchId,
      inventoryItemId: data.inventoryItemId,
      itemName: item.name,
      quantityAfter: transferIn.quantityAfter.toNumber(),
      lowStockThreshold: destStockAfter?.lowStockThreshold?.toNumber() ?? null,
      criticalThreshold: destStockAfter?.criticalThreshold?.toNumber() ?? null,
    });

    return response;
  },

  /**
   * Transfer-destination candidates for the "Destination Branch" picker —
   * the exact same policy transferStock itself enforces
   * (getTransferDestinationBranchIds), so the dropdown never offers a
   * branch the backend would reject. Excludes the source branch itself.
   */
  async getTransferDestinations(fromBranchId: string, actor: ActorContext) {
    const authorizedDestinations = await getTransferDestinationBranchIds(actor);
    const branches = await branchesRepository.findActiveBranchesForTransfer(
      fromBranchId,
      authorizedDestinations === 'all' ? undefined : authorizedDestinations,
    );
    return { branches };
  },

  // --- Physical count (brief §7) ---

  async submitPhysicalCount(data: PhysicalCountInventoryStockData, actor: ActorContext, ipAddress: string | null) {
    const branch = await branchesRepository.findById(data.branchId);
    if (!branch) throw new UniversalInventoryError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    // Sequential, not Promise.all — each count row both reads and writes the
    // same InventoryStock row, matching legacy submitPhysicalCount's reasoning.
    const results = [];
    for (const count of data.counts) {
      const item = await repo.findItemById(count.inventoryItemId);
      if (!item) throw new UniversalInventoryError('INVENTORY_ITEM_NOT_FOUND', `Inventory item ${count.inventoryItemId} not found`, 404);

      const variance = await prisma.$transaction(async (tx) => {
        const stock = await repo.lockAndGetStock(data.branchId, count.inventoryItemId, tx);
        if (!stock) {
          throw new UniversalInventoryError(
            'STOCK_ROW_NOT_FOUND',
            `No InventoryStock row exists for branch/item ${count.inventoryItemId}`,
            404,
          );
        }
        const quantityBefore = stock.quantityOnHand;
        const quantityAfter = new Prisma.Decimal(count.countedQuantity);
        const varianceAmount = quantityAfter.minus(quantityBefore);

        await repo.updateStockQuantity(data.branchId, count.inventoryItemId, quantityAfter, tx);

        if (!varianceAmount.isZero()) {
          await repo.createStockMovement(
            {
              branchId: data.branchId,
              inventoryItemId: count.inventoryItemId,
              movementType: 'PHYSICAL_COUNT',
              quantityChange: varianceAmount,
              quantityBefore,
              quantityAfter,
              unitId: item.baseUnitId,
              notes: data.notes,
              performedByUserId: data.performedByUserId ?? actor.id,
            },
            tx,
          );
        }

        return { previousQuantity: quantityBefore.toNumber(), variance: varianceAmount.toNumber() };
      });

      results.push({
        inventory_item_id: count.inventoryItemId,
        previous_quantity: variance.previousQuantity,
        counted_quantity: count.countedQuantity,
        variance: variance.variance,
      });
    }

    const response = { branch_id: data.branchId, results, submitted_at: new Date().toISOString() };

    await recordAuditLog({
      action: 'INVENTORY_PHYSICAL_COUNT_SUBMITTED',
      entityType: 'inventory_stock_movement',
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    return response;
  },
};
