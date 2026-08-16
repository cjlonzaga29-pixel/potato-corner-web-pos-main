import { z } from 'zod';
import {
  ADJUSTMENT_REASON,
  type AdjustmentReason,
  WASTE_REASON,
  type WasteReason,
  COST_CORRECTION_REASON,
  type CostCorrectionReason,
  IMAGE_PROOF_TYPE,
  type ImageProofType,
} from '../constants/status.js';

const adjustmentReasonValues = Object.values(ADJUSTMENT_REASON) as [AdjustmentReason, ...AdjustmentReason[]];
const wasteReasonValues = Object.values(WASTE_REASON) as [WasteReason, ...WasteReason[]];
const costCorrectionReasonValues = Object.values(COST_CORRECTION_REASON) as [CostCorrectionReason, ...CostCorrectionReason[]];
const imageProofTypeValues = Object.values(IMAGE_PROOF_TYPE) as [ImageProofType, ...ImageProofType[]];

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

// --- Item-specific unit conversions (TASK 121) ---

export const createInventoryItemUnitConversionSchema = z.object({
  from_unit_id: z.uuid(),
  to_unit_id: z.uuid(),
  factor: z.number().positive(),
});

export const updateInventoryItemUnitConversionSchema = z.object({
  factor: z.number().positive(),
});

export const inventoryItemUnitConversionResponseSchema = z.object({
  id: z.uuid(),
  inventory_item_id: z.uuid(),
  from_unit_id: z.uuid(),
  from_unit_code: z.string(),
  from_unit_name: z.string(),
  to_unit_id: z.uuid(),
  to_unit_code: z.string(),
  to_unit_name: z.string(),
  factor: z.number(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const inventoryItemUnitConversionListResponseSchema = z.object({
  conversions: z.array(inventoryItemUnitConversionResponseSchema),
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
  // Total peso cost for this delivery, as printed on the receipt — the
  // per-base-unit carrying cost is derived server-side (total_cost /
  // converted base quantity), never entered by the caller. Replaces the
  // former unit_cost field (Receiving Simplification V2 §1/§4).
  total_cost: z.number().positive('Total cost is required to record acquisition cost'),
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
  responsible_user_id: z.uuid('Select the staff member responsible for this waste'),
  notes: z.string().optional(),
});

export const transferInventoryStockSchema = z.object({
  inventory_item_id: z.uuid(),
  to_branch_id: z.uuid(),
  quantity: z.number().positive(),
  notes: z.string().optional(),
});

export const transferDestinationBranchSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
});

export const transferDestinationListResponseSchema = z.object({
  branches: z.array(transferDestinationBranchSchema),
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
  unit_code: z.string().nullable(),
  reference_type: z.string().nullable(),
  reference_id: z.string().nullable(),
  notes: z.string().nullable(),
  performed_by_user_id: z.uuid().nullable(),
  // Carrying cost snapshot at movement time. Null means "cost not
  // initialized" (legacy row or an item that has never been costed) —
  // never treat null as 0.
  unit_cost: z.number().nullable(),
  total_cost: z.number().nullable(),
  responsible_user_id: z.uuid().nullable(),
  // Purchase-unit quantity/unit as entered (RECEIVING/WASTE only) — distinct
  // from quantity_change/unit_id, which are always base-unit. Null for
  // legacy rows and every other movement type.
  entered_quantity: z.number().nullable(),
  entered_unit_id: z.uuid().nullable(),
  entered_unit_code: z.string().nullable(),
  // Freshly-minted signed URL, resolved on every read — mirrors
  // Expense.receipt_url. Null when no photo was attached.
  proof_url: z.string().nullable(),
  performed_by_name: z.string().nullable(),
  responsible_user_name: z.string().nullable(),
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
  base_unit_id: z.uuid(),
  base_unit_code: z.string(),
  quantity_on_hand: z.number(),
  low_stock_threshold: z.number().nullable(),
  critical_threshold: z.number().nullable(),
  status: z.enum(['healthy', 'low', 'critical']),
  consumed_today: z.number(),
  // Null means "cost not initialized" — never treat as 0.
  avg_unit_cost: z.number().nullable(),
  inventory_value: z.number().nullable(),
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

// ---------------------------------------------------------------------------
// Cost correction (Receiving Simplification V2 §12-15) — a controlled,
// audited change to a branch's current InventoryStock.unit_cost. Never
// rewrites historical movements/COGS/waste; see inventory-cost-correction
// service doc comment for the accounting rule.
// ---------------------------------------------------------------------------

export const createInventoryCostCorrectionSchema = z.object({
  new_unit_cost: z.number().positive('New unit cost must be greater than zero'),
  reason_code: z.enum(costCorrectionReasonValues),
  notes: z.string().max(500).optional(),
});

export const inventoryCostCorrectionResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  // Null only when correcting a never-before-priced ("Cost not initialized") item.
  old_unit_cost: z.number().nullable(),
  new_unit_cost: z.number(),
  quantity_on_hand: z.number(),
  valuation_difference: z.number(),
  reason_code: z.enum(costCorrectionReasonValues),
  notes: z.string().nullable(),
  proof_url: z.string().nullable(),
  corrected_by_user_id: z.uuid(),
  corrected_by_name: z.string(),
  created_at: z.iso.datetime(),
});

export const inventoryCostCorrectionListResponseSchema = z.object({
  corrections: z.array(inventoryCostCorrectionResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

// ---------------------------------------------------------------------------
// Proof photo upload (receiving/waste movements and cost corrections) —
// storage-key-only, mirrors Expense.receiptKey. Multipart requests carry the
// file itself, not JSON, so there's no request-body schema here; only the
// proof_type hint (which capture path the client used) travels as a query/
// form field, validated the same way transaction proof uploads are.
// ---------------------------------------------------------------------------

export const inventoryProofTypeSchema = z.enum(imageProofTypeValues);
