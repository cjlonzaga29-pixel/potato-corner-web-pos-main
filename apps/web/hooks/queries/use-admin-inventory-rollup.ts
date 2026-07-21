'use client';

import { useQuery } from '@tanstack/react-query';
import type { InventoryValuationReportRow, SnapshotResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}
function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Admin-only inventory rollup — no branch_id, aggregates across every branch. */
export function useAdminInventoryRollup() {
  return useQuery({
    queryKey: ['reports', 'ADMIN_INVENTORY_ROLLUP'],
    queryFn: async () => {
      const response = await apiClient<SnapshotResponse<InventoryValuationReportRow>>('/api/reports/inventory-valuation');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory rollup'));
      return response.data;
    },
    staleTime: 60_000,
  });
}
