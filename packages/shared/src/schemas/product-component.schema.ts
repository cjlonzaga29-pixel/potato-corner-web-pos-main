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
});

export const updateProductComponentSchema = z
  .object({
    quantity_required: z.number().positive().optional(),
    recipe_unit_id: z.uuid().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => data.quantity_required !== undefined || data.recipe_unit_id !== undefined || data.is_active !== undefined, {
    message: 'At least one of quantity_required, recipe_unit_id, or is_active must be provided',
  });

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
  version: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
