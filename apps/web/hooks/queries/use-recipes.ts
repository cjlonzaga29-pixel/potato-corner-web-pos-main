'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  CreateRecipeInput,
  RecipeResponse,
  SimulateDeductionInput,
  SimulateDeductionResponse,
  UpdateRecipeInput,
} from '@potato-corner/shared';
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

function invalidateRecipes(queryClient: ReturnType<typeof useQueryClient>, productVariantId: string) {
  void queryClient.invalidateQueries({ queryKey: ['recipes', productVariantId] });
}

export function useCreateRecipe(productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRecipeInput) => {
      const response = await apiClient<RecipeResponse>('/api/recipes', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to add ingredient line'));
      return response.data;
    },
    onSuccess: () => {
      invalidateRecipes(queryClient, productVariantId);
      toast.success('Ingredient line added');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateRecipe(productVariantId: string, recipeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateRecipeInput) => {
      const response = await apiClient<RecipeResponse>(`/api/recipes/${recipeId}`, { method: 'PATCH', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update ingredient line'));
      return response.data;
    },
    onSuccess: () => {
      invalidateRecipes(queryClient, productVariantId);
      toast.success('Ingredient line updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteRecipe(productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (recipeId: string) => {
      const response = await apiClient<null>(`/api/recipes/${recipeId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove ingredient line'));
    },
    onSuccess: () => {
      invalidateRecipes(queryClient, productVariantId);
      toast.success('Ingredient line removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** CR-001 deduction preview — does not mutate stock. */
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
