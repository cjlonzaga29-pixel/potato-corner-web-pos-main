import { z } from 'zod';

// CR-011.1 — Recipe/BOM ProductVariant -> InventoryItem mapping (supersedes
// ProductInventory once a future CR builds POS deduction against it; no
// deduction logic reads this table yet).

export const createProductComponentSchema = z.object({
  product_variant_id: z.uuid(),
  inventory_item_id: z.uuid(),
  quantity_required: z.number().positive(),
  // Optional — defaults to the inventory item's base unit when omitted (see
  // product-components.service.ts). Must share the item's base unit's
  // UnitDimension.
  recipe_unit_id: z.uuid().optional(),
  // Optional — null/omitted means this component belongs to the variant's
  // Base Recipe; a valid ProductOption id scopes it to that option instead.
  product_option_id: z.uuid().nullable().optional(),
});

export const updateProductComponentSchema = z
  .object({
    quantity_required: z.number().positive().optional(),
    recipe_unit_id: z.uuid().optional(),
    is_active: z.boolean().optional(),
    // Omit to leave unchanged; pass null to clear back to Base Recipe.
    product_option_id: z.uuid().nullable().optional(),
  })
  .refine(
    (data) =>
      data.quantity_required !== undefined ||
      data.recipe_unit_id !== undefined ||
      data.is_active !== undefined ||
      data.product_option_id !== undefined,
    {
      message: 'At least one of quantity_required, recipe_unit_id, is_active, or product_option_id must be provided',
    },
  );

export const productComponentResponseSchema = z.object({
  id: z.uuid(),
  product_variant_id: z.uuid(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  inventory_item_sku: z.string().nullable(),
  base_unit_code: z.string(),
  recipe_unit_id: z.uuid(),
  recipe_unit_code: z.string(),
  quantity_required: z.number(),
  is_active: z.boolean(),
  product_option_id: z.uuid().nullable(),
  version: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
