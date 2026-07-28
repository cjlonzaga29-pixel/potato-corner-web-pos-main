'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateProductComponentInput, ProductComponentResponse, UpdateProductComponentInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function queryKey(productVariantId: string) {
  return ['product-components', productVariantId];
}

/** Recipe/BOM components for one product variant (CR-011.1). ProductComponent is not yet the live POS deduction source — ProductInventory still is. */
export function useProductComponents(productVariantId: string | null | undefined) {
  return useQuery({
    queryKey: queryKey(productVariantId ?? ''),
    queryFn: async () => {
      const response = await apiClient<{ components: ProductComponentResponse[] }>(
        `/api/product-components?product_variant_id=${productVariantId}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load recipe components'));
      return response.data.components;
    },
    enabled: Boolean(productVariantId),
    staleTime: 30 * 1000,
  });
}

export function useCreateProductComponent(productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductComponentInput) => {
      const response = await apiClient<ProductComponentResponse>('/api/product-components', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to add recipe component'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKey(productVariantId) });
      toast.success('Recipe component added');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProductComponent(productVariantId: string, componentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductComponentInput) => {
      const response = await apiClient<ProductComponentResponse>(`/api/product-components/${componentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update recipe component'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKey(productVariantId) });
      toast.success('Recipe component updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteProductComponent(productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (componentId: string) => {
      const response = await apiClient<null>(`/api/product-components/${componentId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove recipe component'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKey(productVariantId) });
      toast.success('Recipe component removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
