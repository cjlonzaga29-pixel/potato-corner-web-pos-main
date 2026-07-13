'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  CreateRecipeOverrideInput,
  RecipeOverrideResponse,
  RecipeResponse,
  SimulateDeductionInput,
  SimulateDeductionResponse,
  UpdateRecipeOverrideInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Master recipe rows for a variant — the layer branch overrides sit on top of. */
export function useMasterRecipes(variantId: string | null | undefined) {
  return useQuery({
    queryKey: ['recipes', variantId],
    queryFn: async () => {
      const response = await apiClient<{ recipes: RecipeResponse[] }>(`/api/recipes?product_variant_id=${variantId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load master recipe'));
      return response.data.recipes;
    },
    enabled: Boolean(variantId),
    staleTime: 30 * 1000,
  });
}

export function useRecipeOverrides(variantId: string | null | undefined, branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['recipe-overrides', variantId, branchId],
    queryFn: async () => {
      const response = await apiClient<{ overrides: RecipeOverrideResponse[] }>(
        `/api/recipes/${variantId}/overrides?branch_id=${branchId}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch recipe overrides'));
      return response.data.overrides;
    },
    enabled: Boolean(variantId) && Boolean(branchId),
    staleTime: 15 * 1000,
  });
}

export function useCreateRecipeOverride(variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRecipeOverrideInput) => {
      const response = await apiClient<RecipeOverrideResponse>(`/api/recipes/${variantId}/overrides`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create recipe override'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-overrides', variantId] });
      toast.success('Branch recipe override created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateRecipeOverride(variantId: string, overrideId: string, branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateRecipeOverrideInput) => {
      const response = await apiClient<RecipeOverrideResponse>(`/api/recipes/overrides/${overrideId}?branch_id=${branchId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update recipe override'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-overrides', variantId] });
      toast.success('Branch recipe override updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteRecipeOverride(variantId: string, branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (overrideId: string) => {
      const response = await apiClient<null>(`/api/recipes/overrides/${overrideId}?branch_id=${branchId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete recipe override'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recipe-overrides', variantId] });
      toast.success('Branch recipe override deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useSimulateDeduction() {
  return useMutation({
    mutationFn: async (input: SimulateDeductionInput) => {
      const response = await apiClient<SimulateDeductionResponse>('/api/recipes/simulate', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to simulate deduction'));
      return response.data;
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
