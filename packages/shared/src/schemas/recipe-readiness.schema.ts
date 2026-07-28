import { z } from 'zod';

// CR-011.2 — read-only readiness validation for the CR-012 POS-deduction
// cutover from ProductInventory to ProductComponent. Nothing here mutates
// data; this is a diagnostic report shape only.

export const readinessStatusSchema = z.enum([
  'READY',
  'NO_RECIPE',
  'INVALID_COMPONENT',
  'UNRESOLVED_MAPPING',
  'INCOMPLETE_BRANCH_STOCK',
  'BACKFILL_CONFLICT',
  'LEGACY_FLAVOR_DEPENDENCY',
  'INACTIVE',
]);

export const recipeReadinessQuerySchema = z.object({
  product_id: z.uuid().optional(),
  product_variant_id: z.uuid().optional(),
  branch_id: z.uuid().optional(),
  status: readinessStatusSchema.optional(),
});

export const readinessBlockerSchema = z.object({
  code: readinessStatusSchema,
  message: z.string(),
  inventory_item_ids: z.array(z.uuid()).optional(),
  branch_ids: z.array(z.uuid()).optional(),
});

export const variantReadinessSchema = z.object({
  product_id: z.uuid(),
  product_name: z.string(),
  product_variant_id: z.uuid(),
  variant_name: z.string(),
  size_label: z.string(),
  status: readinessStatusSchema,
  blockers: z.array(readinessBlockerSchema),
  affected_branch_ids: z.array(z.uuid()),
  affected_inventory_item_ids: z.array(z.uuid()),
  available_branch_ids: z.array(z.uuid()),
});

export const readinessSummarySchema = z.object({
  total_variants: z.number().int(),
  ready_count: z.number().int(),
  blocked_count: z.number().int(),
  readiness_percentage: z.number(),
  counts_by_status: z.record(readinessStatusSchema, z.number().int()),
});

export const readinessReportSchema = z.object({
  generated_at: z.iso.datetime(),
  summary: readinessSummarySchema,
  variants: z.array(variantReadinessSchema),
});
