'use client';

import { useQuery } from '@tanstack/react-query';
import type { CatalogResourceType } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export interface CatalogAssignmentHistoryRow {
  id: string;
  resource_type: CatalogResourceType;
  resource_id: string;
  previous_managed_by: string | null;
  new_managed_by: string;
  assigned_by: string;
  reason: string;
  branch_id: string | null;
  created_at: string;
}

// POS-PERF-P36 — read-only internal audit trail of the retired POS-PERF-P35R
// manual catalog-assignment era. No mutation hook exists anymore: catalog
// authority is derived live from a supervisor's active branch assignments
// (see apps/api/src/lib/catalog-authority.ts), not granted through this
// surface. See docs/decisions/POS-PERF-P36-branch-catalog-and-builder.md.
export function useCatalogAssignmentHistory(resourceType: CatalogResourceType | null, resourceId: string | null) {
  return useQuery({
    queryKey: ['catalog-assignments', 'history', resourceType, resourceId],
    queryFn: async () => {
      const response = await apiClient<{ assignments: CatalogAssignmentHistoryRow[] }>(
        `/api/catalog-assignments?resource_type=${resourceType}&resource_id=${resourceId}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load catalog assignment history'));
      return response.data.assignments;
    },
    enabled: Boolean(resourceType && resourceId),
  });
}
