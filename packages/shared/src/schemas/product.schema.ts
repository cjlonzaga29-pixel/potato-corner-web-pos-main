import { z } from 'zod';
import { PRODUCT_STATUS, type ProductStatus } from '../constants/status.js';

const productStatusValues = Object.values(PRODUCT_STATUS) as [ProductStatus, ...ProductStatus[]];
const CREATABLE_STATUSES = new Set<ProductStatus>([PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.ACTIVE]);

/** true when `value`, rounded to `max` decimal places, doesn't change — rejects e.g. 19.999 at max=2. */
function hasMaxDecimals(max: number) {
  const factor = 10 ** max;
  return (value: number) => Math.round(value * factor) / factor === value;
}

const moneySchema = (message: string) =>
  z.number().positive().refine(hasMaxDecimals(2), { message });

/**
 * Shared cross-field seasonal validation, used by both createProductSchema
 * and updateProductSchema. is_seasonal true requires both dates; providing
 * one date requires the other; end must not precede start.
 */
function validateSeasonalFields(
  data: { is_seasonal?: boolean; seasonal_start_date?: string; seasonal_end_date?: string },
  ctx: z.RefinementCtx,
): void {
  const hasStart = data.seasonal_start_date !== undefined;
  const hasEnd = data.seasonal_end_date !== undefined;

  if (data.is_seasonal && (!hasStart || !hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['seasonal_start_date'],
      message: 'Seasonal products require both a start date and an end date',
    });
    return;
  }

  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: 'custom',
      path: [hasStart ? 'seasonal_end_date' : 'seasonal_start_date'],
      message: 'seasonal_start_date and seasonal_end_date must be provided together',
    });
    return;
  }

  if (hasStart && hasEnd && data.seasonal_start_date !== undefined && data.seasonal_end_date !== undefined) {
    if (data.seasonal_end_date < data.seasonal_start_date) {
      ctx.addIssue({
        code: 'custom',
        path: ['seasonal_end_date'],
        message: 'seasonal_end_date must not be before seasonal_start_date',
      });
    }
  }
}

/**
 * Wire-format fields are snake_case, matching the employees module's
 * convention (see employee.schema.ts) rather than the branches module's
 * camelCase — this module's request/response shapes were specified that
 * way in the Phase 6 spec and are kept internally consistent with it.
 */
export const createProductSchema = z
  .object({
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
    status: z.enum(productStatusValues).default(PRODUCT_STATUS.DRAFT),
    display_order: z.number().int().nonnegative().optional(),
    is_seasonal: z.boolean().default(false),
    seasonal_start_date: z.iso.date().optional(),
    seasonal_end_date: z.iso.date().optional(),
    image_url: z.url().optional(),
    // CR-001: cascade default is "all active branches"; branch_exclusive flips
    // that to "requesting branch only" and requires exclusive_branch_id.
    branch_exclusive: z.boolean().default(false),
    exclusive_branch_id: z.uuid().optional(),
  })
  .superRefine((data, ctx) => {
    if (!CREATABLE_STATUSES.has(data.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A product can only be created with draft or active status',
      });
    }
    if (data.branch_exclusive && !data.exclusive_branch_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['exclusive_branch_id'],
        message: 'exclusive_branch_id is required when branch_exclusive is true',
      });
    }
    if (!data.branch_exclusive && data.exclusive_branch_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['exclusive_branch_id'],
        message: 'exclusive_branch_id must only be set when branch_exclusive is true',
      });
    }
    validateSeasonalFields(data, ctx);
  });

/** status is deliberately absent — lifecycle transitions go through changeProductStatusSchema, not this generic update. */
export const updateProductSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
    display_order: z.number().int().nonnegative().optional(),
    is_seasonal: z.boolean().optional(),
    seasonal_start_date: z.iso.date().nullable().optional(),
    seasonal_end_date: z.iso.date().nullable().optional(),
    image_url: z.url().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    validateSeasonalFields(
      {
        is_seasonal: data.is_seasonal,
        seasonal_start_date: data.seasonal_start_date ?? undefined,
        seasonal_end_date: data.seasonal_end_date ?? undefined,
      },
      ctx,
    );
  });

export const changeProductStatusSchema = z.object({
  status: z.enum([
    PRODUCT_STATUS.ACTIVE,
    PRODUCT_STATUS.TEMPORARILY_UNAVAILABLE,
    PRODUCT_STATUS.DISCONTINUED,
    PRODUCT_STATUS.ARCHIVED,
  ]),
  branch_id: z.uuid().optional(),
  reason: z.string().max(255).optional(),
});

export const createVariantSchema = z.object({
  name: z.string().min(1).max(50),
  size_label: z.string().min(1).max(30),
  base_price: moneySchema('base_price must have at most 2 decimal places'),
  display_order: z.number().int().nonnegative().optional(),
  is_active: z.boolean().default(true),
});

export const updateVariantSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  size_label: z.string().min(1).max(30).optional(),
  base_price: moneySchema('base_price must have at most 2 decimal places').optional(),
  display_order: z.number().int().nonnegative().optional(),
  is_active: z.boolean().optional(),
});

export const productVariantResponseSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  name: z.string(),
  size_label: z.string(),
  base_price: z.number(),
  display_order: z.number().int().nullable(),
  is_active: z.boolean(),
  flavors: z.array(
    z.object({
      flavor_id: z.uuid(),
      name: z.string(),
      color_hex: z.string().nullable(),
      price_premium: z.number(),
      is_available: z.boolean(),
    }),
  ),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const branchProductAvailabilityRowSchema = z.object({
  branch_id: z.uuid(),
  branch_code: z.string(),
  branch_name: z.string(),
  city: z.string(),
  is_available: z.boolean(),
  updated_at: z.iso.datetime().nullable(),
});

export const productResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  image_url: z.string().nullable(),
  status: z.enum(productStatusValues),
  status_label: z.string(),
  display_order: z.number().int().nullable(),
  is_seasonal: z.boolean(),
  seasonal_start_date: z.iso.date().nullable(),
  seasonal_end_date: z.iso.date().nullable(),
  branch_exclusive: z.boolean(),
  exclusive_branch_id: z.uuid().nullable(),
  exclusive_branch_name: z.string().nullable(),
  created_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  variant_count: z.number().int(),
  active_variant_count: z.number().int(),
  active_branch_count: z.number().int(),
});

export const productDetailResponseSchema = productResponseSchema.extend({
  variants: z.array(productVariantResponseSchema),
  branch_availability: z.array(branchProductAvailabilityRowSchema),
  created_by_user: z
    .object({ id: z.uuid(), first_name: z.string(), last_name: z.string(), email: z.email() })
    .nullable(),
});

export const productListResponseSchema = z.object({
  products: z.array(productResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

// ---------------------------------------------------------------------------
// POS catalog (Phase 10) — a lean, staff-accessible read model distinct from
// the admin/supervisor productResponseSchema above: branch-filtered to only
// what's actually sellable right now, with the effective (override-aware)
// price already resolved server-side so the terminal never computes pricing.
// ---------------------------------------------------------------------------

export const posCatalogFlavorSchema = z.object({
  flavor_id: z.uuid(),
  name: z.string(),
  color_hex: z.string().nullable(),
  price_premium: z.number(),
});

export const posCatalogVariantSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  size_label: z.string(),
  price: z.number(),
  flavors: z.array(posCatalogFlavorSchema),
});

export const posCatalogProductSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  category: z.string().nullable(),
  image_url: z.string().nullable(),
  variants: z.array(posCatalogVariantSchema),
});

export const posCatalogResponseSchema = z.object({
  categories: z.array(z.string()),
  products: z.array(posCatalogProductSchema),
});
