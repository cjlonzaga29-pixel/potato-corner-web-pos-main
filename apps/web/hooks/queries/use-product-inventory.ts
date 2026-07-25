'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateProductInventoryInput, ProductInventoryResponse, UpdateProductInventoryInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Business-neutral stock-item mappings for one product variant (Phase 6 foundation). Recipe remains the active POS deduction engine — these mappings are additive, informational only. */
export function useProductInventoryList(productVariantId: string | null | undefined) {
  return useQuery({
    queryKey: ['product-inventory', productVariantId],
    queryFn: async () => {
      const response = await apiClient<{ mappings: ProductInventoryResponse[] }>(
        `/api/product-inventory?product_variant_id=${productVariantId}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory item mappings'));
      return response.data.mappings;
    },
    enabled: Boolean(productVariantId),
    staleTime: 30 * 1000,
  });
}

function invalidateProductInventory(queryClient: ReturnType<typeof useQueryClient>, productVariantId: string) {
  void queryClient.invalidateQueries({ queryKey: ['product-inventory', productVariantId] });
}

export function useCreateProductInventory(productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductInventoryInput) => {
      const response = await apiClient<ProductInventoryResponse>('/api/product-inventory', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to add inventory item'));
      return response.data;
    },
    onSuccess: () => {
      invalidateProductInventory(queryClient, productVariantId);
      toast.success('Inventory item added');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProductInventory(productVariantId: string, mappingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductInventoryInput) => {
      const response = await apiClient<ProductInventoryResponse>(`/api/product-inventory/${mappingId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update inventory item'));
      return response.data;
    },
    onSuccess: () => {
      invalidateProductInventory(queryClient, productVariantId);
      toast.success('Inventory item updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteProductInventory(productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mappingId: string) => {
      const response = await apiClient<null>(`/api/product-inventory/${mappingId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove inventory item'));
    },
    onSuccess: () => {
      invalidateProductInventory(queryClient, productVariantId);
      toast.success('Inventory item removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
