import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProductTypeInput, ProductTypeListResponse, ProductTypeResponse, UpdateProductTypeInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { productApiError } from '@/hooks/queries/use-products';

interface ProductTypeFilters {
  /** Only types usable at this branch. */
  branchId?: string;
  includeInactive?: boolean;
}

/** POS-PERF-P58 — built-ins plus the caller's custom types. On failure callers fall back to BUILT_IN_PRODUCT_TYPES (lib/product-types.ts). */
export function useProductTypes(filters: ProductTypeFilters = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['product-types', filters],
    queryFn: async () => {
      const params = new URLSearchParams({ include_inactive: String(filters.includeInactive ?? true) });
      if (filters.branchId) params.set('branch_id', filters.branchId);
      const response = await apiClient<ProductTypeListResponse>(`/api/product-types?${params.toString()}`);
      if (!response.data) throw productApiError(response, 'Failed to load product types');
      return response.data.types;
    },
    staleTime: 30 * 1000,
    enabled: options.enabled ?? true,
  });
}

function useProductTypeWrite<TInput>(request: (input: TInput) => Promise<{ data: ProductTypeResponse | null; error: { code: string; message?: string } | string | null }>, fallback: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => {
      const response = await request(input);
      if (!response.data) throw productApiError(response, fallback);
      return response.data;
    },
    // Awaited so a closing dialog's caller sees the new type and its new version.
    onSuccess: async () => {
      // Product rows and details carry the type's current name and active state.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['product'] });
      await queryClient.invalidateQueries({ queryKey: ['product-types'] });
    },
  });
}

export function useCreateProductType() {
  return useProductTypeWrite(
    (input: CreateProductTypeInput) => apiClient<ProductTypeResponse>('/api/product-types', { method: 'POST', body: JSON.stringify(input) }),
    'Failed to create this product type',
  );
}

export function useUpdateProductType(productTypeId: string) {
  return useProductTypeWrite(
    (input: UpdateProductTypeInput) => apiClient<ProductTypeResponse>(`/api/product-types/${productTypeId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    'Failed to save this product type',
  );
}

export function useSetProductTypeActive(productTypeId: string) {
  return useProductTypeWrite(
    ({ isActive, expectedVersion }: { isActive: boolean; expectedVersion: number }) =>
      apiClient<ProductTypeResponse>(`/api/product-types/${productTypeId}/${isActive ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: JSON.stringify({ expected_version: expectedVersion }),
      }),
    'Failed to change this product type',
  );
}
