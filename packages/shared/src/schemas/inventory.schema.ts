import { z } from 'zod';
import {
  MOVEMENT_TYPE,
  type MovementType,
  IMAGE_PROOF_TYPE,
  type ImageProofType,
  ADJUSTMENT_REASON,
  type AdjustmentReason,
  WASTE_REASON,
  type WasteReason,
} from '../constants/status.js';

const movementTypeValues = Object.values(MOVEMENT_TYPE) as [MovementType, ...MovementType[]];
const imageProofTypeValues = Object.values(IMAGE_PROOF_TYPE) as [ImageProofType, ...ImageProofType[]];
const adjustmentReasonValues = Object.values(ADJUSTMENT_REASON) as [AdjustmentReason, ...AdjustmentReason[]];
const wasteReasonValues = Object.values(WASTE_REASON) as [WasteReason, ...WasteReason[]];

/**
 * Wire-format fields are snake_case, matching the products/flavors module
 * convention established in Phase 6 (see product.schema.ts) rather than this
 * file's original Phase-0-scaffolded camelCase — this module had no real
 * router/service consuming it yet, so there was no compatibility to preserve.
 */
export const createIngredientSchema = z.object({
  branch_id: z.uuid(),
  name: z.string().min(1).max(100),
  unit: z.string().min(1).max(20),
  current_stock: z.number().nonnegative().default(0),
  low_stock_threshold: z.number().nonnegative(),
  critical_threshold: z.number().nonnegative(),
  unit_cost: z.number().nonnegative().optional(),
});

export const ingredientResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  current_stock: z.number(),
  low_stock_threshold: z.number(),
  critical_threshold: z.number(),
  unit_cost: z.number().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const ingredientListResponseSchema = z.object({
  ingredients: z.array(ingredientResponseSchema),
});

export const updateIngredientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  unit: z.string().min(1).max(20).optional(),
  low_stock_threshold: z.number().nonnegative().optional(),
  critical_threshold: z.number().nonnegative().optional(),
  unit_cost: z.number().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Phase 8 — stock movement operations. Every one of these appends to the
// InventoryMovement ledger; current stock is never written directly.
// ---------------------------------------------------------------------------

export const stockInSchema = z.object({
  quantity: z.number().positive(),
  supplier_reference: z.string().max(100).optional(),
  notes: z.string().optional(),
});

export const adjustIngredientSchema = z.object({
  quantity_delta: z.number().refine((n) => n !== 0, 'quantity_delta must not be zero'),
  reason_code: z.enum(adjustmentReasonValues),
  notes: z.string().optional(),
});

export const wasteIngredientSchema = z.object({
  quantity: z.number().positive(),
  reason_code: z.enum(wasteReasonValues),
  notes: z.string().optional(),
  image_proof_url: z.url().optional(),
  image_proof_type: z.enum(imageProofTypeValues).optional(),
});

export const transferIngredientSchema = z.object({
  ingredient_id: z.uuid(),
  to_branch_id: z.uuid(),
  quantity: z.number().positive(),
  notes: z.string().optional(),
});

export const movementResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  movement_type: z.enum(movementTypeValues),
  quantity_change: z.number(),
  quantity_before: z.number(),
  quantity_after: z.number(),
  reference_id: z.uuid().nullable(),
  notes: z.string().nullable(),
  image_proof_url: z.url().nullable(),
  image_proof_type: z.enum(imageProofTypeValues).nullable(),
  approved_by: z.uuid().nullable(),
  recorded_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});

export const movementListResponseSchema = z.object({
  movements: z.array(movementResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const branchInventoryRowSchema = z.object({
  ingredient_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  current_stock: z.number(),
  low_stock_threshold: z.number(),
  critical_threshold: z.number(),
  status: z.enum(['ok', 'low', 'critical']),
});

export const branchInventoryResponseSchema = z.object({
  branch_id: z.uuid(),
  ingredients: z.array(branchInventoryRowSchema),
});

export const inventoryAlertSchema = z.object({
  ingredient_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  current_stock: z.number(),
  threshold: z.number(),
  severity: z.enum(['low', 'critical']),
});

export const inventoryAlertListResponseSchema = z.object({
  branch_id: z.uuid(),
  alerts: z.array(inventoryAlertSchema),
});

export const physicalCountResultRowSchema = z.object({
  ingredient_id: z.uuid(),
  counted_quantity: z.number(),
  previous_quantity: z.number(),
  variance: z.number(),
});

export const physicalCountResultResponseSchema = z.object({
  branch_id: z.uuid(),
  results: z.array(physicalCountResultRowSchema),
  submitted_at: z.iso.datetime(),
});

export const transferIngredientResponseSchema = z.object({
  ingredient_id: z.uuid(),
  to_branch_id: z.uuid(),
  to_ingredient_id: z.uuid(),
  quantity: z.number(),
  transfer_out: movementResponseSchema,
  transfer_in: movementResponseSchema,
});

/**
 * Master recipe row. flavor_id is nullable — NULL means this row is a base
 * ingredient applied regardless of flavor selection. A specific flavor_id
 * means the row applies only when that flavor is selected, and overrides the
 * base quantity for the same ingredient (architecture doc §7.1).
 */
export const createRecipeSchema = z.object({
  product_variant_id: z.uuid(),
  ingredient_id: z.uuid(),
  flavor_id: z.uuid().nullable().optional(),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(20),
});

export const updateRecipeSchema = z.object({
  quantity: z.number().positive().optional(),
  unit: z.string().min(1).max(20).optional(),
});

export const recipeResponseSchema = z.object({
  id: z.uuid(),
  product_variant_id: z.uuid(),
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  flavor_id: z.uuid().nullable(),
  flavor_name: z.string().nullable(),
  quantity: z.number(),
  unit: z.string(),
});

export const createInventoryMovementSchema = z.object({
  branch_id: z.uuid(),
  ingredient_id: z.uuid(),
  movement_type: z.enum(movementTypeValues),
  quantity_change: z.number(),
  notes: z.string().optional(),
  image_proof_url: z.url().optional(),
  image_proof_type: z.enum(imageProofTypeValues).optional(),
  reference_id: z.uuid().optional(),
});

export const physicalCountSubmissionSchema = z.object({
  branch_id: z.uuid(),
  started_at: z.iso.datetime(),
  counts: z
    .array(
      z.object({
        ingredient_id: z.uuid(),
        counted_quantity: z.number().nonnegative(),
      }),
    )
    .min(1),
  notes: z.string().optional(),
});
