import { z } from 'zod';

// POS-PERF-P35R — explicit catalog-management assignment. A Super Admin
// action that hands management responsibility for a shared/orphaned/
// other-owned catalog or inventory-definition record to a specific active
// Supervisor. Never overwrites the record's original createdBy provenance;
// see docs/decisions/POS-PERF-P35R-catalog-assignment.md.

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

export const createCatalogAssignmentSchema = z.object({
  resource_type: z.enum(CATALOG_RESOURCE_TYPES),
  resource_id: z.uuid(),
  supervisor_id: z.uuid(),
  reason: z.string().trim().min(10).max(500),
});

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

export const catalogUnmanagedResourceResponseSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  created_by: z.uuid().nullable(),
});

export const catalogUnmanagedListResponseSchema = z.object({
  resources: z.array(catalogUnmanagedResourceResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const catalogAssignmentImpactPreviewResponseSchema = z.object({
  resource_type: z.enum(CATALOG_RESOURCE_TYPES),
  resource_id: z.uuid(),
  resource_label: z.string(),
  current_created_by: z.uuid().nullable(),
  current_managed_by: z.uuid().nullable(),
  current_manager_label: z.string().nullable(),
  // Other catalog records that reference this one (e.g. products under a
  // category, options under a group) — reassigning management of THIS
  // record never changes who manages those dependents.
  dependent_summary: z.array(
    z.object({
      resource_type: z.enum(CATALOG_RESOURCE_TYPES),
      count: z.number().int(),
      distinct_other_managers: z.number().int(),
    }),
  ),
  eligible_branch_ids: z.array(z.uuid()).nullable(),
});
