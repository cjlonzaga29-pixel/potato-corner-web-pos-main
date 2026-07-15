import { z } from 'zod';

/** true when `value`, rounded to `max` decimal places, doesn't change — rejects e.g. 19.999 at max=2. */
function hasMaxDecimals(max: number) {
  const factor = 10 ** max;
  return (value: number) => Math.round(value * factor) / factor === value;
}

export const colorHexSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be in #RRGGBB format');

export const createFlavorSchema = z.object({
  name: z.string().min(2).max(50),
  description: z.string().max(255).optional(),
  color_hex: colorHexSchema,
  display_order: z.number().int().nonnegative().optional(),
  is_active: z.boolean().default(true),
});

export const updateFlavorSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().max(255).optional(),
  color_hex: colorHexSchema.optional(),
  display_order: z.number().int().nonnegative().optional(),
  is_active: z.boolean().optional(),
});

export const linkVariantFlavorSchema = z.object({
  flavor_id: z.uuid(),
  price_premium: z
    .number()
    .nonnegative()
    .refine(hasMaxDecimals(2), { message: 'price_premium must have at most 2 decimal places' })
    .default(0),
  is_available: z.boolean().default(true),
});

export const updateVariantFlavorSchema = z.object({
  price_premium: z
    .number()
    .nonnegative()
    .refine(hasMaxDecimals(2), { message: 'price_premium must have at most 2 decimal places' })
    .optional(),
  is_available: z.boolean().optional(),
});

/** Body shape for PATCH /api/products/:productId/branch-availability/:branchId — branchId itself comes from the route param. */
export const branchProductAvailabilitySchema = z.object({
  branch_id: z.uuid(),
  is_available: z.boolean(),
});

/** Body shape for PATCH /api/flavors/:flavorId/branch-availability/:branchId — branchId itself comes from the route param. */
export const branchFlavorAvailabilitySchema = z.object({
  branch_id: z.uuid(),
  is_available: z.boolean(),
  unavailable_reason: z.string().max(255).optional(),
});

export const flavorResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  color_hex: z.string().nullable(),
  display_order: z.number().int().nullable(),
  is_active: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  branch_active_count: z.number().int(),
  linked_variant_count: z.number().int(),
});

export const flavorListResponseSchema = z.object({
  flavors: z.array(flavorResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const branchFlavorAvailabilityRowSchema = z.object({
  branch_id: z.uuid(),
  branch_code: z.string(),
  branch_name: z.string(),
  city: z.string(),
  is_available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  updated_at: z.iso.datetime().nullable(),
});

export const flavorLinkedVariantSchema = z.object({
  product_variant_id: z.uuid(),
  variant_name: z.string(),
  size_label: z.string(),
  product_id: z.uuid(),
  product_name: z.string(),
  price_premium: z.number(),
  is_available: z.boolean(),
});

export const flavorDetailResponseSchema = flavorResponseSchema.extend({
  branch_availability: z.array(branchFlavorAvailabilityRowSchema),
  linked_variants: z.array(flavorLinkedVariantSchema),
});
