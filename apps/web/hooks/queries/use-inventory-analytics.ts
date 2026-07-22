'use client';

import { useQuery } from '@tanstack/react-query';
import type { InventoryAnalyticsReport } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

export type InventoryAnalyticsPeriod = '7d' | '30d' | '90d' | '1yr';

export interface InventoryAnalyticsFilters {
  branchId?: string;
  period?: InventoryAnalyticsPeriod;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}
function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: InventoryAnalyticsFilters): string {
  const params = new URLSearchParams();
  if (filters.branchId) params.set('branch_id', filters.branchId);
  params.set('period', filters.period ?? '30d');
  return params.toString();
}

/** GET /api/reports/inventory-analytics — admin/supervisor only, branch-guarded. */
export function useInventoryAnalytics(filters: InventoryAnalyticsFilters = {}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isLoading = useAuthStore((s) => s.isLoading);

  return useQuery({
    queryKey: ['reports', 'inventory-analytics', filters],
    queryFn: async () => {
      const response = await apiClient<InventoryAnalyticsReport>(`/api/reports/inventory-analytics?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory analytics'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading,
    staleTime: 60_000,
  });
}
