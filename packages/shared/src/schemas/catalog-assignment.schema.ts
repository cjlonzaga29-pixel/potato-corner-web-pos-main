import { z } from 'zod';

// POS-PERF-P36 — CatalogManagementAssignment is now an append-only audit
// trail of the retired POS-PERF-P35R manual-assignment era; catalog
// authority is derived live from a supervisor's active branch assignments
// (see apps/api/src/lib/catalog-authority.ts) instead of being granted here.
// Only the read/history schemas survive — the create-assignment,
// impact-preview, and unmanaged-list schemas had no remaining caller once
// the write endpoint was removed.

export const CATALOG_RESOURCE_TYPES = [
  'PRODUCT',
  'PRODUCT_CATEGORY',
  'PRODUCT_OPTION_GROUP',
  'PRODUCT_OPTION',
  'INVENTORY_CATEGORY',
  'UNIT_OF_MEASURE',
  'UNIT_CONVERSION',
  'INVENTORY_ITEM',
] as const;
export type CatalogResourceType = (typeof CATALOG_RESOURCE_TYPES)[number];

export const catalogAssignmentResponseSchema = z.object({
  id: z.uuid(),
  resource_type: z.enum(CATALOG_RESOURCE_TYPES),
  resource_id: z.uuid(),
  previous_managed_by: z.uuid().nullable(),
  new_managed_by: z.uuid(),
  assigned_by: z.uuid(),
  reason: z.string(),
  branch_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});
