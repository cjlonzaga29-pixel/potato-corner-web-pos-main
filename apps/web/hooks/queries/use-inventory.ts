'use client';

import { useQuery } from '@tanstack/react-query';
import type { IngredientListResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Phase 7 foundation: ingredient master data, scoped to one branch. */
export function useIngredients(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['ingredients', branchId],
    queryFn: async () => {
      const response = await apiClient<IngredientListResponse>(`/api/inventory/ingredients?branch_id=${branchId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load ingredients'));
      return response.data.ingredients;
    },
    enabled: Boolean(branchId),
    staleTime: 30 * 1000,
  });
}
