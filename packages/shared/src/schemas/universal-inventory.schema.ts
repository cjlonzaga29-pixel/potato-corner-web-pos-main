import { z } from 'zod';

// CR-010 — Universal Inventory identity layer (InventoryItem/Category/Unit/
// Conversion + branch assignment). Admin-owned; see docs/decisions/CR-010.

export const createInventoryCategorySchema = z.object({
  name: z.string().min(1, 'name is required'),
  code: z.string().min(1).optional(),
  description: z.string().optional(),
});

export const updateInventoryCategorySchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
});

const unitDimensionEnum = z.enum(['WEIGHT', 'VOLUME', 'COUNT']);

export const createUnitOfMeasureSchema = z.object({
  code: z.string().min(1, 'code is required'),
  name: z.string().min(1, 'name is required'),
  dimension: unitDimensionEnum,
  is_base_unit: z.boolean().optional(),
});

export const updateUnitOfMeasureSchema = z.object({
  name: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
});

export const createUnitConversionSchema = z.object({
  from_unit_id: z.uuid(),
  to_unit_id: z.uuid(),
  factor: z.number().positive(),
});

export const createInventoryItemSchema = z.object({
  name: z.string().min(1, 'name is required'),
  sku: z.string().min(1).optional(),
  barcode: z.string().min(1).optional(),
  category_id: z.uuid().optional(),
  base_unit_id: z.uuid(),
  track_inventory: z.boolean().optional(),
});

export const updateInventoryItemSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.string().min(1).nullable().optional(),
  barcode: z.string().min(1).nullable().optional(),
  category_id: z.uuid().nullable().optional(),
  track_inventory: z.boolean().optional(),
});

export const assignInventoryItemToBranchesSchema = z.object({
  branch_ids: z.array(z.string().min(1)).min(1, 'at least one branch_id is required'),
});

export const inventoryCategoryResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const unitOfMeasureResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  dimension: unitDimensionEnum,
  is_base_unit: z.boolean(),
  is_active: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const unitConversionResponseSchema = z.object({
  id: z.uuid(),
  from_unit_id: z.uuid(),
  to_unit_id: z.uuid(),
  factor: z.number(),
  created_at: z.iso.datetime(),
});

export const inventoryItemResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  category_id: z.uuid().nullable(),
  category_name: z.string().nullable(),
  base_unit_id: z.uuid(),
  base_unit_code: z.string().nullable(),
  track_inventory: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const inventoryItemBranchAssignmentSchema = z.object({
  branch_id: z.string(),
  branch_code: z.string(),
  branch_name: z.string(),
  city: z.string(),
  quantity_on_hand: z.number(),
});

export const inventoryItemDetailResponseSchema = inventoryItemResponseSchema.extend({
  assigned_branches: z.array(inventoryItemBranchAssignmentSchema),
});

export const assignInventoryItemToBranchesResponseSchema = z.object({
  assigned: z.array(z.string()),
  already_assigned: z.array(z.string()),
});
