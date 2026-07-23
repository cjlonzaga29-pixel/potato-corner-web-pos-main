import { z } from 'zod';
import { REQUEST_STATUS } from '../constants/status.js';
import { colorHexSchema } from './flavor.schema.js';

const requestStatusValues = Object.values(REQUEST_STATUS) as [string, ...string[]];

export const createFlavorRequestSchema = z.object({
  branch_id: z.uuid(),
  proposed_name: z.string().min(2).max(50),
  proposed_description: z.string().max(255).optional(),
  proposed_color_hex: colorHexSchema,
  proposed_display_order: z.number().int().nonnegative().optional(),
  request_reason: z.string().min(30, 'request_reason must be at least 30 characters'),
});

export const reviewFlavorRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    review_notes: z.string().optional(),
    overrides: z
      .object({
        proposed_name: z.string().min(2).max(50).optional(),
        proposed_description: z.string().max(255).optional(),
        proposed_color_hex: colorHexSchema.optional(),
        proposed_display_order: z.number().int().nonnegative().optional(),
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

export const flavorRequestResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  requested_by: z.uuid(),
  requested_by_name: z.string(),
  proposed_name: z.string(),
  proposed_description: z.string().nullable(),
  proposed_color_hex: z.string(),
  proposed_display_order: z.number().int().nullable(),
  request_reason: z.string(),
  status: z.enum(requestStatusValues),
  reviewed_by: z.uuid().nullable(),
  reviewed_by_name: z.string().nullable(),
  reviewed_at: z.iso.datetime().nullable(),
  review_notes: z.string().nullable(),
  created_flavor_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const flavorRequestListResponseSchema = z.object({
  requests: z.array(flavorRequestResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
