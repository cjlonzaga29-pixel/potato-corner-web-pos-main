import { z } from 'zod';

// CR-012.1A -- read-only Shadow BOM Deduction dashboard contract. Mirrors
// GET /api/shadow-bom-deduction/summary and .../details exactly. Nothing
// here mutates data; this is a diagnostic report shape only.

export const shadowBomClassificationSchema = z.enum([
  'MATCH',
  'BOM_NOT_READY',
  'MISSING_LEGACY_MAPPING',
  'MISSING_BOM_COMPONENT',
  'EXTRA_BOM_COMPONENT',
  'QUANTITY_MISMATCH',
  'UNIT_CONVERSION_UNSUPPORTED',
  'FLAVOR_DEPENDENCY',
  'ERROR',
]);

export const shadowBomDeductionFilterQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  branch_id: z.uuid().optional(),
  product_variant_id: z.uuid().optional(),
  classification: shadowBomClassificationSchema.optional(),
});

export const shadowBomDeductionDetailsQuerySchema = shadowBomDeductionFilterQuerySchema.extend({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
});

export const shadowBomDeductionSummarySchema = z.object({
  total_compared: z.number().int(),
  match_count: z.number().int(),
  match_percentage: z.number(),
  counts_by_classification: z.partialRecord(shadowBomClassificationSchema, z.number().int()),
  affected_product_variant_ids: z.array(z.uuid()),
  affected_branch_ids: z.array(z.uuid()),
});

export const shadowBomDeductionDetailRowSchema = z.object({
  id: z.uuid(),
  transaction_id: z.uuid(),
  sale_line_id: z.uuid(),
  branch_id: z.uuid(),
  product_variant_id: z.uuid(),
  legacy_calculation: z.unknown(),
  bom_calculation: z.unknown(),
  classification: shadowBomClassificationSchema,
  error_details: z.unknown(),
  compared_at: z.iso.datetime(),
});

export const shadowBomDeductionDetailsPageSchema = z.object({
  rows: z.array(shadowBomDeductionDetailRowSchema),
  page: z.number().int(),
  page_size: z.number().int(),
  total: z.number().int(),
});

export type ShadowBomClassificationValue = z.infer<typeof shadowBomClassificationSchema>;
export type ShadowBomDeductionFilterQuery = z.infer<typeof shadowBomDeductionFilterQuerySchema>;
export type ShadowBomDeductionDetailsQuery = z.infer<typeof shadowBomDeductionDetailsQuerySchema>;
export type ShadowBomDeductionSummary = z.infer<typeof shadowBomDeductionSummarySchema>;
export type ShadowBomDeductionDetailRow = z.infer<typeof shadowBomDeductionDetailRowSchema>;
export type ShadowBomDeductionDetailsPage = z.infer<typeof shadowBomDeductionDetailsPageSchema>;
