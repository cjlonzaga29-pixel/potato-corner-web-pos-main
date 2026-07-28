'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  ShadowBomClassificationValue,
  ShadowBomDeductionDetailsPage,
  ShadowBomDeductionSummary,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export interface ShadowBomDeductionFilters {
  since?: string;
  until?: string;
  branchId?: string;
  productVariantId?: string;
  classification?: ShadowBomClassificationValue;
}

function buildFilterParams(filters: ShadowBomDeductionFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  if (filters.branchId) params.set('branch_id', filters.branchId);
  if (filters.productVariantId) params.set('product_variant_id', filters.productVariantId);
  if (filters.classification) params.set('classification', filters.classification);
  return params;
}

/** CR-012.1A -- read-only shadow BOM deduction summary for the Super Admin dashboard. Never mutates data. */
export function useShadowBomDeductionSummary(filters: ShadowBomDeductionFilters = {}, enabled = true) {
  const query = buildFilterParams(filters).toString();

  return useQuery({
    queryKey: ['shadow-bom-deduction-summary', filters],
    queryFn: async () => {
      const response = await apiClient<ShadowBomDeductionSummary>(
        `/api/shadow-bom-deduction/summary${query ? `?${query}` : ''}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load shadow BOM deduction summary'));
      return response.data;
    },
    enabled,
    staleTime: 0,
  });
}

export interface ShadowBomDeductionDetailsFilters extends ShadowBomDeductionFilters {
  page?: number;
  pageSize?: number;
}

/** CR-012.1A -- read-only, paginated shadow BOM deduction comparison rows for the Super Admin dashboard. Never mutates data. */
export function useShadowBomDeductionDetails(filters: ShadowBomDeductionDetailsFilters = {}, enabled = true) {
  const params = buildFilterParams(filters);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.pageSize) params.set('page_size', String(filters.pageSize));
  const query = params.toString();

  return useQuery({
    queryKey: ['shadow-bom-deduction-details', filters],
    queryFn: async () => {
      const response = await apiClient<ShadowBomDeductionDetailsPage>(
        `/api/shadow-bom-deduction/details${query ? `?${query}` : ''}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load shadow BOM deduction details'));
      return response.data;
    },
    enabled,
    staleTime: 0,
  });
}
