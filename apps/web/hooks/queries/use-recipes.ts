'use client';

import { useQuery } from '@tanstack/react-query';
import type { RecipeResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Master recipe ingredient lines for one product variant (Phase 7 foundation — no aggregate "recipe" entity, rows are the unit). */
export function useRecipesList(productVariantId: string | null | undefined) {
  return useQuery({
    queryKey: ['recipes', productVariantId],
    queryFn: async () => {
      const response = await apiClient<{ recipes: RecipeResponse[] }>(`/api/recipes?product_variant_id=${productVariantId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load recipe'));
      return response.data.recipes;
    },
    enabled: Boolean(productVariantId),
    staleTime: 30 * 1000,
  });
}
