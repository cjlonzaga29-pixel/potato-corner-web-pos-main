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

/** Branch-scoped stock-item mappings for one product variant (Phase 6 foundation). ProductInventory is the active POS deduction mapping source, not Recipe. */
export function useProductInventoryList(branchId: string | null | undefined, productVariantId: string | null | undefined) {
  return useQuery({
    queryKey: ['product-inventory', branchId, productVariantId],
    queryFn: async () => {
      const response = await apiClient<{ mappings: ProductInventoryResponse[] }>(
        `/api/product-inventory?branch_id=${branchId}&product_variant_id=${productVariantId}`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory item mappings'));
      return response.data.mappings;
    },
    enabled: Boolean(branchId) && Boolean(productVariantId),
    staleTime: 30 * 1000,
  });
}

function invalidateProductInventory(queryClient: ReturnType<typeof useQueryClient>, branchId: string | null, productVariantId: string) {
  void queryClient.invalidateQueries({ queryKey: ['product-inventory', branchId, productVariantId] });
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
    onSuccess: (_data, variables) => {
      invalidateProductInventory(queryClient, variables.branch_id, productVariantId);
      toast.success('Inventory item added');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProductInventory(branchId: string | null, productVariantId: string, mappingId: string) {
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
      invalidateProductInventory(queryClient, branchId, productVariantId);
      toast.success('Inventory item updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Toggles is_active for a mapping without touching quantity/unit — distinct from delete, which permanently removes the row (see useDeleteProductInventory). Takes the mapping id per-call so one hook instance can drive Deactivate/Activate across a whole list. */
export function useSetProductInventoryActive(branchId: string | null, productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ mappingId, is_active }: { mappingId: string; is_active: boolean }) => {
      const response = await apiClient<ProductInventoryResponse>(`/api/product-inventory/${mappingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update inventory item status'));
      return response.data;
    },
    onSuccess: (_data, variables) => {
      invalidateProductInventory(queryClient, branchId, productVariantId);
      toast.success(variables.is_active ? 'Inventory item activated' : 'Inventory item deactivated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteProductInventory(branchId: string | null, productVariantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mappingId: string) => {
      const response = await apiClient<null>(`/api/product-inventory/${mappingId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove inventory item'));
    },
    onSuccess: () => {
      invalidateProductInventory(queryClient, branchId, productVariantId);
      toast.success('Inventory item removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
