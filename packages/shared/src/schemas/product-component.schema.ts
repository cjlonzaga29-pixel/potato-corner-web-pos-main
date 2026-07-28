import { z } from 'zod';

// CR-010 R8 — extensible ProductVariant -> InventoryItem mapping (supersedes
// ProductInventory once a future CR builds deduction against it; no
// Recipe/BOM or POS deduction logic is implemented here).

export const createProductComponentSchema = z.object({
  product_variant_id: z.uuid(),
  inventory_item_id: z.uuid(),
  quantity_required: z.number().positive(),
});

export const updateProductComponentSchema = z.object({
  quantity_required: z.number().positive().optional(),
});

export const productComponentResponseSchema = z.object({
  id: z.uuid(),
  product_variant_id: z.uuid(),
  inventory_item_id: z.uuid(),
  inventory_item_name: z.string(),
  inventory_item_sku: z.string().nullable(),
  base_unit_code: z.string(),
  quantity_required: z.number(),
  version: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
