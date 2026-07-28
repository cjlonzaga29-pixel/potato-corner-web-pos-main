'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export type ReadinessStatus =
  | 'READY'
  | 'NO_RECIPE'
  | 'INVALID_COMPONENT'
  | 'UNRESOLVED_MAPPING'
  | 'INCOMPLETE_BRANCH_STOCK'
  | 'BACKFILL_CONFLICT'
  | 'LEGACY_FLAVOR_DEPENDENCY'
  | 'INACTIVE';

export interface ReadinessBlockerResponse {
  code: ReadinessStatus;
  message: string;
  inventory_item_ids: string[];
  branch_ids: string[];
}

export interface VariantReadinessResponse {
  product_id: string;
  product_name: string;
  product_variant_id: string;
  variant_name: string;
  size_label: string;
  status: ReadinessStatus;
  blockers: ReadinessBlockerResponse[];
  affected_branch_ids: string[];
  affected_inventory_item_ids: string[];
  available_branch_ids: string[];
}

export interface ReadinessReportResponse {
  generated_at: string;
  summary: {
    total_variants: number;
    ready_count: number;
    blocked_count: number;
    readiness_percentage: number;
    counts_by_status: Record<ReadinessStatus, number>;
  };
  variants: VariantReadinessResponse[];
}

export interface RecipeReadinessFilters {
  productId?: string;
  productVariantId?: string;
  branchId?: string;
  status?: ReadinessStatus;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export function useRecipeReadiness(filters: RecipeReadinessFilters = {}, enabled = true) {
  const params = new URLSearchParams();
  if (filters.productId) params.set('product_id', filters.productId);
  if (filters.productVariantId) params.set('product_variant_id', filters.productVariantId);
  if (filters.branchId) params.set('branch_id', filters.branchId);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();

  return useQuery({
    queryKey: ['recipe-readiness', filters],
    queryFn: async () => {
      const response = await apiClient<ReadinessReportResponse>(`/api/recipe-readiness${query ? `?${query}` : ''}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load recipe readiness report'));
      return response.data;
    },
    enabled,
    staleTime: 0,
  });
}
