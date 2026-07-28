import { z } from 'zod';

export const createProductInventorySchema = z.object({
  branch_id: z.string().min(1, 'branch_id is required'),
  product_variant_id: z.uuid(),
  ingredient_id: z.uuid(),
  flavor_id: z.uuid().nullable().optional(),
  quantity_required: z.number().positive(),
  unit: z.string().min(1, 'unit is required'),
});

export const updateProductInventorySchema = z.object({
  quantity_required: z.number().positive().optional(),
  unit: z.string().min(1, 'unit is required').optional(),
  is_active: z.boolean().optional(),
});

export const productInventoryResponseSchema = z.object({
  id: z.uuid(),
  product_variant_id: z.uuid(),
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  flavor_id: z.uuid().nullable(),
  flavor_name: z.string().nullable(),
  quantity_required: z.number(),
  unit: z.string(),
  is_active: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
