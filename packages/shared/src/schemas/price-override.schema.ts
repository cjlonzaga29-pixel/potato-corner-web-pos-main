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

export const createPriceOverrideSchema = z.object({
  branch_id: z.uuid(),
  product_variant_id: z.uuid(),
  requested_price: moneySchema,
  request_reason: z.string().min(20, 'request_reason must be at least 20 characters'),
});

export const reviewPriceOverrideSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    review_notes: z.string().optional(),
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

export const priceOverrideResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  product_variant_id: z.uuid(),
  variant_name: z.string(),
  product_name: z.string(),
  master_price: z.number(),
  requested_price: z.number(),
  status: z.enum(requestStatusValues),
  requested_by: z.uuid(),
  requested_by_name: z.string(),
  request_reason: z.string(),
  reviewed_by: z.uuid().nullable(),
  reviewed_by_name: z.string().nullable(),
  reviewed_at: z.iso.datetime().nullable(),
  review_notes: z.string().nullable(),
  effective_from: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const priceOverrideListResponseSchema = z.object({
  overrides: z.array(priceOverrideResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
