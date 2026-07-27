import { z } from 'zod';

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
