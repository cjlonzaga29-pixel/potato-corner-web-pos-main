import { z } from 'zod';

/**
 * CR-001 Phase 7.5 — branch-level recipe overrides. A supervisor may replace
 * or add ingredient rows for their branch without Super Admin approval; every
 * override is audit-logged with a reason (min 20 chars, locked rule).
 */
export const createRecipeOverrideSchema = z.object({
  branch_id: z.uuid(),
  ingredient_id: z.uuid(),
  flavor_id: z.uuid().nullable().optional(),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(20),
  reason: z.string().min(20, 'reason must be at least 20 characters'),
});

export const updateRecipeOverrideSchema = z.object({
  quantity: z.number().positive().optional(),
  unit: z.string().min(1).max(20).optional(),
  reason: z.string().min(20, 'reason must be at least 20 characters'),
});

export const recipeOverrideResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  product_variant_id: z.uuid(),
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  flavor_id: z.uuid().nullable(),
  flavor_name: z.string().nullable(),
  quantity: z.number(),
  unit: z.string(),
  reason: z.string(),
  created_by: z.uuid(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

/**
 * Dry-run deduction preview. branch_id omitted -> master recipe only;
 * branch_id present -> master recipe layered with that branch's overrides.
 * Mirrors computeDeduction's own signature exactly (see recipes.service.ts).
 */
export const simulateDeductionSchema = z.object({
  product_variant_id: z.uuid(),
  flavor_id: z.uuid().nullable().optional(),
  quantity_sold: z.number().int().positive(),
  branch_id: z.uuid().optional(),
});

export const deductionLineSchema = z.object({
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  source: z.enum(['master_base', 'master_flavor', 'branch_base', 'branch_flavor']),
});

export const simulateDeductionResponseSchema = z.object({
  product_variant_id: z.uuid(),
  flavor_id: z.uuid().nullable(),
  branch_id: z.uuid().nullable(),
  quantity_sold: z.number().int(),
  lines: z.array(deductionLineSchema),
});
