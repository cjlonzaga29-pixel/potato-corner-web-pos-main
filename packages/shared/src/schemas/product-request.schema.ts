import { z } from 'zod';
import { REQUEST_STATUS } from '../constants/status.js';

const requestStatusValues = Object.values(REQUEST_STATUS) as [string, ...string[]];

function hasMaxDecimals(max: number) {
  const factor = 10 ** max;
  return (value: number) => Math.round(value * factor) / factor === value;
}

const moneySchema = z
  .number()
  .positive()
  .refine(hasMaxDecimals(2), { message: 'must have at most 2 decimal places' });

export const proposedVariantSchema = z.object({
  name: z.string().min(1).max(50),
  size_label: z.string().min(1).max(30),
  base_price: moneySchema,
  display_order: z.number().int().nonnegative().optional(),
});

export const proposedFlavorSchema = z.object({
  flavor_id: z.uuid().optional(),
  name: z.string().min(2).max(50).optional(),
  color_hex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  price_premium: z.number().nonnegative().default(0),
});

/** variant_index references proposed_variants by array position — CR-001's product request has no persisted variant ids to key off yet. */
export const proposedRecipeSchema = z.object({
  variant_index: z.number().int().nonnegative(),
  ingredient_id: z.uuid(),
  flavor_id: z.uuid().nullable().optional(),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(20),
});

export const createProductRequestSchema = z.object({
  branch_id: z.uuid(),
  proposed_name: z.string().min(2).max(100),
  proposed_description: z.string().max(500).optional(),
  proposed_category: z.string().max(50).optional(),
  proposed_variants: z.array(proposedVariantSchema).min(1),
  proposed_flavors: z.array(proposedFlavorSchema).default([]),
  proposed_recipes: z.array(proposedRecipeSchema).default([]),
  request_reason: z.string().min(30, 'request_reason must be at least 30 characters'),
});

export const reviewProductRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    review_notes: z.string().optional(),
    overrides: z
      .object({
        proposed_name: z.string().min(2).max(100).optional(),
        proposed_description: z.string().max(500).optional(),
        proposed_category: z.string().max(50).optional(),
        proposed_variants: z.array(proposedVariantSchema).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'reject' && (!data.review_notes || data.review_notes.length < 20)) {
      ctx.addIssue({
        code: 'custom',
        path: ['review_notes'],
        message: 'review_notes must be at least 20 characters when rejecting',
      });
    }
  });

export const productRequestResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  requested_by: z.uuid(),
  requested_by_name: z.string(),
  proposed_name: z.string(),
  proposed_description: z.string().nullable(),
  proposed_category: z.string().nullable(),
  proposed_variants: z.array(proposedVariantSchema),
  proposed_flavors: z.array(proposedFlavorSchema),
  proposed_recipes: z.array(proposedRecipeSchema),
  request_reason: z.string(),
  status: z.enum(requestStatusValues),
  reviewed_by: z.uuid().nullable(),
  reviewed_by_name: z.string().nullable(),
  reviewed_at: z.iso.datetime().nullable(),
  review_notes: z.string().nullable(),
  created_product_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const productRequestListResponseSchema = z.object({
  requests: z.array(productRequestResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
