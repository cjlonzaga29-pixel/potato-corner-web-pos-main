import { z } from 'zod';
import { PRODUCT_CLASSIFICATIONS, PRODUCT_CLASSIFICATION_LABELS } from './product.schema.js';

/**
 * POS-PERF-P58 — supervisor-created product types (Marketing, One-time, ...)
 * alongside the built-in Regular/Promotional/Seasonal. A type is a label: it
 * never discounts, expires, publishes or changes a recipe, stock or tax. See
 * docs/runbooks/pos-perf-p58-custom-product-types.md.
 */
const MAX_PRODUCT_TYPE_NAME = 60;
const MAX_PRODUCT_TYPE_BRANCHES = 100;

/**
 * The one definition of "the same name": compatibility forms folded, outer
 * whitespace dropped, inner whitespace collapsed, case ignored. The database's
 * unique index compares the stored result of this, never the display name.
 */
export function normalizeProductTypeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const RESERVED_NAMES = new Set(PRODUCT_CLASSIFICATIONS.map((key) => normalizeProductTypeName(PRODUCT_CLASSIFICATION_LABELS[key])));

export function isReservedProductTypeName(name: string): boolean {
  return RESERVED_NAMES.has(normalizeProductTypeName(name));
}

const productTypeNameSchema = z
  .string()
  .transform((name) => name.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter a name')
      .max(MAX_PRODUCT_TYPE_NAME, `Use at most ${MAX_PRODUCT_TYPE_NAME} characters`)
      .refine((name) => !isReservedProductTypeName(name), { message: 'Regular, Promotional and Seasonal already exist' }),
  );

const productTypeDescriptionSchema = z.string().trim().max(300, 'Use at most 300 characters');

const productTypeBranchIdsSchema = z.array(z.uuid()).min(1, 'Select at least one branch').max(MAX_PRODUCT_TYPE_BRANCHES);

export const createProductTypeSchema = z.object({
  name: productTypeNameSchema,
  description: productTypeDescriptionSchema.optional(),
  branch_ids: productTypeBranchIdsSchema,
});

/** branch_ids is the whole new scope and may only add branches: products already use the current ones. */
export const updateProductTypeSchema = z.object({
  name: productTypeNameSchema.optional(),
  description: productTypeDescriptionSchema.nullable().optional(),
  branch_ids: productTypeBranchIdsSchema.optional(),
  expected_version: z.number().int().positive(),
});

export const productTypeTransitionSchema = z.object({ expected_version: z.number().int().positive() });

export const productTypeResponseSchema = z.object({
  /** What products store and filter by: a built-in's classification, or a custom type's id. */
  key: z.string(),
  id: z.uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  is_builtin: z.boolean(),
  is_active: z.boolean(),
  version: z.number().int(),
  /** Empty for a built-in, which applies everywhere. */
  branches: z.array(z.object({ branch_id: z.uuid(), branch_name: z.string() })),
  /** The caller's live assignments cover the type's whole scope. Always false for a built-in. */
  can_manage: z.boolean(),
  /** Null for a built-in. */
  product_count: z.number().int().nullable(),
});

export const productTypeListResponseSchema = z.object({ types: z.array(productTypeResponseSchema) });
