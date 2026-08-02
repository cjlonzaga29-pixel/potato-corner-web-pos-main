import { z } from 'zod';

// CR-008 — Universal Product Catalog: company-owned Product Categories and a
// generic Option Group/Option architecture (Flavor/Size/Add-ons/etc.),
// distinct from the legacy standalone Flavor system (see flavor.schema.ts),
// which remains untouched until FINAL-RESET.

const codeSchema = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, 'code must be lowercase alphanumeric with optional - or _ separators');

// ---------------------------------------------------------------------------
// Product Category (R1)
// ---------------------------------------------------------------------------

export const createProductCategorySchema = z.object({
  code: codeSchema,
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().nonnegative().optional(),
});

export const updateProductCategorySchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().nonnegative().optional(),
});

export const productCategoryResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  sort_order: z.number().int().nullable(),
  product_count: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const productCategoryListResponseSchema = z.object({
  categories: z.array(productCategoryResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

// ---------------------------------------------------------------------------
// Product Option Group (R4) / Product Option (R5)
// ---------------------------------------------------------------------------

export const PRODUCT_OPTION_SELECTION_TYPES = ['SINGLE', 'MULTIPLE'] as const;
export type ProductOptionSelectionType = (typeof PRODUCT_OPTION_SELECTION_TYPES)[number];

export const createProductOptionGroupSchema = z
  .object({
    code: codeSchema,
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
    pos_button_label: z.string().trim().max(100).nullable().optional(),
    selection_type: z.enum(PRODUCT_OPTION_SELECTION_TYPES),
    min_selections: z.number().int().nonnegative().default(0),
    max_selections: z.number().int().positive().optional(),
    required: z.boolean().default(false),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.selection_type === 'SINGLE' && data.max_selections !== undefined && data.max_selections > 1) {
      ctx.addIssue({ code: 'custom', path: ['max_selections'], message: 'A SINGLE selection group cannot allow more than 1 selection' });
    }
    if (data.max_selections !== undefined && data.min_selections > data.max_selections) {
      ctx.addIssue({ code: 'custom', path: ['min_selections'], message: 'min_selections cannot exceed max_selections' });
    }
  });

export const updateProductOptionGroupSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(500).optional(),
    pos_button_label: z.string().trim().max(100).nullable().optional(),
    selection_type: z.enum(PRODUCT_OPTION_SELECTION_TYPES).optional(),
    min_selections: z.number().int().nonnegative().optional(),
    max_selections: z.number().int().positive().nullable().optional(),
    required: z.boolean().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.selection_type === 'SINGLE' &&
      data.max_selections !== undefined &&
      data.max_selections !== null &&
      data.max_selections > 1
    ) {
      ctx.addIssue({ code: 'custom', path: ['max_selections'], message: 'A SINGLE selection group cannot allow more than 1 selection' });
    }
    if (
      data.min_selections !== undefined &&
      data.max_selections !== undefined &&
      data.max_selections !== null &&
      data.min_selections > data.max_selections
    ) {
      ctx.addIssue({ code: 'custom', path: ['min_selections'], message: 'min_selections cannot exceed max_selections' });
    }
  });

export const productOptionGroupResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  pos_button_label: z.string().nullable(),
  selection_type: z.enum(PRODUCT_OPTION_SELECTION_TYPES),
  min_selections: z.number().int(),
  max_selections: z.number().int().nullable(),
  required: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int().nullable(),
  option_count: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const productOptionGroupListResponseSchema = z.object({
  option_groups: z.array(productOptionGroupResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

// TASK 75 — dedicated inventory deduction directly on a Product Option (see
// ProductOptionInventoryMapping in schema.prisma). Category/base unit are
// never accepted here; they're always derived server-side from InventoryItem.
export const productOptionInventoryDeductionInputSchema = z.object({
  inventory_item_id: z.uuid(),
  deduction_unit_id: z.uuid(),
  quantity_required: z.number().positive(),
});

export const createProductOptionSchema = z.object({
  code: codeSchema,
  name: z.string().min(1).max(100),
  price_adjustment: z.number().default(0),
  image_url: z.url().optional(),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().nonnegative().optional(),
  inventory_deduction: productOptionInventoryDeductionInputSchema.optional(),
});

export const updateProductOptionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  price_adjustment: z.number().optional(),
  image_url: z.url().nullable().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  // undefined (key omitted) = preserve existing mapping; null = remove it;
  // object = create or update it.
  inventory_deduction: productOptionInventoryDeductionInputSchema.nullable().optional(),
});

export const productOptionInventoryDeductionResponseSchema = z
  .object({
    inventory_item_id: z.uuid(),
    inventory_item_name: z.string(),
    inventory_category_id: z.uuid().nullable(),
    inventory_category_name: z.string().nullable(),
    base_unit_id: z.uuid(),
    base_unit_code: z.string(),
    base_unit_name: z.string(),
    deduction_unit_id: z.uuid(),
    deduction_unit_code: z.string(),
    deduction_unit_name: z.string(),
    quantity_required: z.number(),
  })
  .nullable();

export const productOptionResponseSchema = z.object({
  id: z.uuid(),
  option_group_id: z.uuid(),
  code: z.string(),
  name: z.string(),
  price_adjustment: z.number(),
  image_url: z.string().nullable(),
  is_active: z.boolean(),
  sort_order: z.number().int().nullable(),
  inventory_deduction: productOptionInventoryDeductionResponseSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const productOptionGroupDetailResponseSchema = productOptionGroupResponseSchema.extend({
  options: z.array(productOptionResponseSchema),
});

// ---------------------------------------------------------------------------
// Variant <-> Option Group assignment (R6)
// ---------------------------------------------------------------------------

export const assignVariantOptionGroupSchema = z.object({
  option_group_id: z.uuid(),
  required: z.boolean().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  // Subset of the group's options allowed on this variant. Omitted/empty
  // means every active option in the group is allowed.
  allowed_option_ids: z.array(z.uuid()).optional(),
});

export const updateVariantOptionGroupSchema = z.object({
  required: z.boolean().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  allowed_option_ids: z.array(z.uuid()).optional(),
});

export const variantOptionGroupResponseSchema = z.object({
  id: z.uuid(),
  product_variant_id: z.uuid(),
  option_group_id: z.uuid(),
  code: z.string(),
  name: z.string(),
  selection_type: z.enum(PRODUCT_OPTION_SELECTION_TYPES),
  min_selections: z.number().int(),
  max_selections: z.number().int().nullable(),
  required: z.boolean(),
  sort_order: z.number().int().nullable(),
  allowed_options: z.array(
    z.object({
      product_option_id: z.uuid(),
      code: z.string(),
      name: z.string(),
      price_adjustment: z.number(),
      is_active: z.boolean(),
      sort_order: z.number().int().nullable(),
    }),
  ),
});

// Reverse lookup — which Product Variants a given Product Option is
// assigned to (via ProductVariantOptionGroupOption), for the Manage
// Deduction dialog's "used by" list.
export const productOptionAssignedVariantResponseSchema = z.object({
  product_variant_id: z.uuid(),
  variant_name: z.string(),
  product_id: z.uuid(),
  product_name: z.string(),
});
