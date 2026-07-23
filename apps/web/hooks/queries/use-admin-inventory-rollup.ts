'use client';

import { useQuery } from '@tanstack/react-query';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type { InventoryValuationReportRow, SnapshotResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

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

/** Keeps the all-branches inventory rollup in sync with stock movements recorded at any branch, without a manual refresh. */
export function useAdminInventoryRollupRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, SOCKET_EVENTS.INVENTORY_LOW_STOCK, SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK],
    [['reports', 'ADMIN_INVENTORY_ROLLUP']],
  );
}
