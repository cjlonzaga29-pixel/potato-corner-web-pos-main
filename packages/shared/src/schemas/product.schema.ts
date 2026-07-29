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
    // CR-008: canonical ProductCategory FK, additive alongside legacy `category`.
    category_id: z.uuid().optional(),
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
    category_id: z.uuid().nullable().optional(),
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

/** Body shape for PATCH /api/products/:productId/branch-availability/bulk. */
export const bulkBranchProductAvailabilitySchema = z
  .object({
    updates: z
      .array(
        z.object({
          branch_id: z.uuid(),
          is_available: z.boolean(),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine((data) => new Set(data.updates.map((u) => u.branch_id)).size === data.updates.length, {
    message: 'Duplicate branch_id entries are not allowed',
  });

export const bulkBranchProductAvailabilityResponseSchema = z.object({
  updated_count: z.number().int(),
  product_id: z.uuid(),
});

export const productResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  category_id: z.uuid().nullable(),
  category_name: z.string().nullable(),
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

// CR-008 — read-only surface of a variant's assigned Option Groups (R11/R12:
// additive read adapter only, no pricing/deduction logic reads this field).
export const posCatalogOptionGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  selection_type: z.enum(['SINGLE', 'MULTIPLE']),
  required: z.boolean(),
});

// Mix & Max — one flavor selector per ProductFlavorSlot row, ordered by
// slot_index. Only variants with flavor slots use this; others keep `flavors`.
export const posCatalogSnackOptionSchema = z.object({
  product_variant_id: z.uuid(),
  product_name: z.string(),
  variant_name: z.string(),
  flavors: z.array(posCatalogFlavorSchema),
});

export const posCatalogFlavorSlotSchema = z.object({
  slot_index: z.number().int(),
  label: z.string(),
  required: z.boolean(),
  snack_options: z.array(posCatalogSnackOptionSchema),
});

// Live POS readiness — computed server-side by productReadinessService
// (Phase B — CR-008) in productsService.getPosCatalog, replacing the former
// inline ProductInventory-only computation. readiness_code is the
// highest-priority blocking issue collapsed to one of these legacy codes for
// existing clients; blocking_issues/readiness_warnings carry the full list.
export const POS_READINESS_CODES = [
  'READY',
  'MISSING_BASE_MAPPING',
  'MISSING_FLAVOR_MAPPING',
  'NOT_AVAILABLE_IN_BRANCH',
  'INACTIVE',
  'PRICE_MISSING',
  'MIX_MAX_INCOMPLETE',
] as const;
export type PosReadinessCode = (typeof POS_READINESS_CODES)[number];

export const posCatalogReadinessIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['blocking', 'warning']),
  message: z.string(),
  flavor_name: z.string().nullable(),
});

export const posCatalogVariantSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  size_label: z.string(),
  price: z.number(),
  vatable_cap_amount: z.number().nullable(),
  live_ready: z.boolean(),
  readiness_code: z.enum(POS_READINESS_CODES),
  missing_flavor_ids: z.array(z.uuid()),
  // Additive (Phase B) — backward-compatible with the fields above.
  readiness_status: z.enum(['READY', 'NOT_READY']),
  completion_percentage: z.number(),
  blocking_issues: z.array(posCatalogReadinessIssueSchema),
  readiness_warnings: z.array(posCatalogReadinessIssueSchema),
  flavors: z.array(posCatalogFlavorSchema),
  flavor_slots: z.array(posCatalogFlavorSlotSchema),
  option_groups: z.array(posCatalogOptionGroupSchema),
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

// ---------------------------------------------------------------------------
// Phase D1 — Admin Readiness panel & product-level publish/unpublish. Reuses
// the existing BranchProductAvailability model (no schema changes); every
// readiness computation is delegated to productReadinessService (the same
// engine POS/Checkout use), never re-derived here.
// ---------------------------------------------------------------------------

/** entity_id/product_variant_id/flavor_id are omitted from this DTO on purpose (spec: "do not expose internal IDs" in the admin UI) — message + recommended_action already carry the human-readable explanation. */
export const readinessIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['blocking', 'warning']),
  entity_type: z.enum(['product', 'product_variant', 'flavor', 'flavor_slot', 'branch']),
  message: z.string(),
  recommended_action: z.string(),
  flavor_name: z.string().nullable(),
});

export const productVariantReadinessSummarySchema = z.object({
  product_variant_id: z.uuid(),
  variant_name: z.string(),
  status: z.enum(['READY', 'NOT_READY']),
  sellable: z.boolean(),
  completion_percentage: z.number(),
  recipe_ready: z.boolean(),
  inventory_mapping_ready: z.boolean(),
  blocking_issues: z.array(readinessIssueSchema),
  warnings: z.array(readinessIssueSchema),
});

export const productReadinessResponseSchema = z.object({
  scope: z.literal('branch'),
  product_id: z.uuid(),
  branch_id: z.uuid(),
  status: z.enum(['READY', 'NOT_READY']),
  sellable: z.boolean(),
  completion_percentage: z.number(),
  variant_count: z.number().int(),
  eligible_variant_count: z.number().int(),
  ready_variant_count: z.number().int(),
  blocking_issues: z.array(readinessIssueSchema),
  warnings: z.array(readinessIssueSchema),
  variants: z.array(productVariantReadinessSummarySchema),
  // Known limitation (Phase D1, do not fix here): BranchProductAvailability is
  // product-level, so publish/unpublish always applies to every variant of
  // this product at the branch — there is no per-variant branch publishing.
  publish_is_variant_level: z.literal(false),
});

/** All Branches view — read-only summary per branch; publishing is disabled in this scope (a single branch must be selected to publish/unpublish). */
export const productReadinessAllBranchesResponseSchema = z.object({
  scope: z.literal('all_branches'),
  product_id: z.uuid(),
  branches: z.array(
    z.object({
      branch_id: z.uuid(),
      branch_name: z.string(),
      status: z.enum(['READY', 'NOT_READY']),
      sellable: z.boolean(),
      completion_percentage: z.number(),
      is_published: z.boolean(),
      blocking_issue_count: z.number().int(),
      warning_count: z.number().int(),
    }),
  ),
});

export const publishProductSchema = z.object({
  branch_id: z.uuid(),
});

export const unpublishProductSchema = z.object({
  branch_id: z.uuid(),
});
