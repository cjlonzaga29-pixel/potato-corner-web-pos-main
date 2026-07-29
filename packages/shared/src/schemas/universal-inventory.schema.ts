import { z } from 'zod';
import { ADJUSTMENT_REASON, type AdjustmentReason, WASTE_REASON, type WasteReason } from '../constants/status.js';

const adjustmentReasonValues = Object.values(ADJUSTMENT_REASON) as [AdjustmentReason, ...AdjustmentReason[]];
const wasteReasonValues = Object.values(WASTE_REASON) as [WasteReason, ...WasteReason[]];

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

// ---------------------------------------------------------------------------
// Branch inventory cutover — direct InventoryStock operations. Every one of
// these appends to the InventoryStockMovement ledger in the same transaction
// as the InventoryStock.quantity_on_hand update it explains; quantities are
// never written outside that pairing.
// ---------------------------------------------------------------------------

const stockMovementTypeEnum = z.enum([
  'RECEIVING',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'WASTE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'PHYSICAL_COUNT',
  'SALE',
  'SALE_REVERSAL',
]);

export const receiveInventoryStockSchema = z.object({
  quantity: z.number().positive(),
  entered_unit_id: z.uuid().optional(),
  delivery_reference: z.string().max(100).optional(),
  notes: z.string().optional(),
});

export const adjustInventoryStockSchema = z.object({
  quantity_delta: z.number().refine((n) => n !== 0, 'quantity_delta must not be zero'),
  reason_code: z.enum(adjustmentReasonValues),
  notes: z.string().optional(),
});

export const wasteInventoryStockSchema = z.object({
  quantity: z.number().positive(),
  entered_unit_id: z.uuid().optional(),
  reason_code: z.enum(wasteReasonValues),
  notes: z.string().optional(),
});

export const transferInventoryStockSchema = z.object({
  inventory_item_id: z.uuid(),
  to_branch_id: z.uuid(),
  quantity: z.number().positive(),
  notes: z.string().optional(),
});

export const physicalCountInventoryStockSchema = z.object({
  counts: z
    .array(
      z.object({
        inventory_item_id: z.uuid(),
        counted_quantity: z.number().nonnegative(),
      }),
    )
    .min(1),
  notes: z.string().optional(),
});

export const inventoryStockMovementResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  movement_type: stockMovementTypeEnum,
  quantity_change: z.number(),
  quantity_before: z.number(),
  quantity_after: z.number(),
  unit_id: z.uuid().nullable(),
  reference_type: z.string().nullable(),
  reference_id: z.string().nullable(),
  notes: z.string().nullable(),
  performed_by_user_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});

export const inventoryStockMovementListResponseSchema = z.object({
  movements: z.array(inventoryStockMovementResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const branchInventoryStockRowSchema = z.object({
  inventory_item_id: z.uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  category_name: z.string().nullable(),
  base_unit_code: z.string(),
  quantity_on_hand: z.number(),
  low_stock_threshold: z.number().nullable(),
  critical_threshold: z.number().nullable(),
  status: z.enum(['healthy', 'low', 'critical']),
});

export const branchInventoryStockListResponseSchema = z.object({
  branch_id: z.uuid(),
  items: z.array(branchInventoryStockRowSchema),
});

export const inventoryStockAlertSchema = z.object({
  inventory_item_id: z.uuid(),
  name: z.string(),
  quantity_on_hand: z.number(),
  threshold: z.number(),
  severity: z.enum(['low', 'critical']),
});

export const inventoryStockAlertListResponseSchema = z.object({
  branch_id: z.uuid(),
  alerts: z.array(inventoryStockAlertSchema),
});

export const inventoryStockTransferResponseSchema = z.object({
  inventory_item_id: z.uuid(),
  to_branch_id: z.uuid(),
  quantity: z.number(),
  transfer_out: inventoryStockMovementResponseSchema,
  transfer_in: inventoryStockMovementResponseSchema,
});

export const physicalCountStockResultRowSchema = z.object({
  inventory_item_id: z.uuid(),
  previous_quantity: z.number(),
  counted_quantity: z.number(),
  variance: z.number(),
});

export const physicalCountStockResultResponseSchema = z.object({
  branch_id: z.uuid(),
  results: z.array(physicalCountStockResultRowSchema),
  submitted_at: z.iso.datetime(),
});
