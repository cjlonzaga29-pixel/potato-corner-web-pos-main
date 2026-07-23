'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  BranchProductAvailabilityRow,
  BulkBranchProductAvailabilityResponse,
  ChangeProductStatusInput,
  CreateVariantInput,
  LinkVariantFlavorInput,
  PosCatalogResponse,
  ProductDetailResponse,
  ProductListResponse,
  ProductStatus,
  ProductVariantResponse,
  UpdateProductInput,
  UpdateVariantFlavorInput,
  UpdateVariantInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { PRODUCT_CACHE_REFRESH_MINUTES } from '@/lib/constants';

export interface ProductFilters {
  status?: ProductStatus;
  category?: string;
  search?: string;
  isSeasonal?: boolean;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_at' | 'updated_at' | 'display_order' | 'status';
  sortOrder?: 'asc' | 'desc';
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: ProductFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.category) params.set('category', filters.category);
  if (filters.search) params.set('search', filters.search);
  if (filters.isSeasonal !== undefined) params.set('is_seasonal', String(filters.isSeasonal));
  if (filters.sortBy) params.set('sort_by', filters.sortBy);
  if (filters.sortOrder) params.set('sort_order', filters.sortOrder);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useProducts(filters: ProductFilters = {}) {
  return useQuery({
    queryKey: ['products', filters],
    queryFn: async () => {
      const response = await apiClient<ProductListResponse>(`/api/products?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load products'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useProduct(productId: string | null | undefined) {
  return useQuery({
    queryKey: ['product', productId],
    queryFn: async () => {
      const response = await apiClient<ProductDetailResponse>(`/api/products/${productId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load product'));
      return response.data;
    },
    enabled: Boolean(productId),
    staleTime: 30 * 1000,
  });
}

/** POS terminal catalog (Phase 10) — branch-filtered, availability-checked, override-priced. Distinct from useProducts (admin/supervisor management view). */
export function useCatalog(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['catalog', branchId],
    queryFn: async () => {
      const response = await apiClient<PosCatalogResponse>(`/api/products/catalog?branch_id=${branchId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load the product catalog'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 60 * 1000,
    // Architecture doc §10.1 / cache.ts's own comment: the offline catalog
    // cache must refresh "on connect and at least every 30 minutes during
    // active use." staleTime alone doesn't guarantee that — without an
    // explicit refetchInterval, a terminal session that stays mounted
    // without a refocus/reconnect event to trigger a refetch would just
    // sit on a stale query indefinitely past the 60s staleTime.
    refetchInterval: PRODUCT_CACHE_REFRESH_MINUTES * 60 * 1000,
  });
}

export function useUpdateProduct(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductInput) => {
      const response = await apiClient<ProductDetailResponse>(`/api/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update product'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useChangeProductStatus(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChangeProductStatusInput) => {
      const response = await apiClient<ProductDetailResponse | BranchProductAvailabilityRow>(`/api/products/${productId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to change product status'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
      toast.success('Product status updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUploadProductImage(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.set('image', file);
      const response = await apiClient<{ image_url: string }>(`/api/products/${productId}/image`, {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload product image'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product image uploaded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useBranchProductAvailability(productId: string | null | undefined) {
  return useQuery({
    queryKey: ['product', productId, 'branch-availability'],
    queryFn: async () => {
      const response = await apiClient<BranchProductAvailabilityRow[]>(`/api/products/${productId}/branch-availability`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch availability'));
      return response.data;
    },
    enabled: Boolean(productId),
    staleTime: 30 * 1000,
  });
}

export function useUpdateBranchProductAvailability(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ branchId, isAvailable }: { branchId: string; isAvailable: boolean }) => {
      const response = await apiClient<BranchProductAvailabilityRow>(`/api/products/${productId}/branch-availability/${branchId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_available: isAvailable }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update branch availability'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Branch availability updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useBulkUpdateBranchProductAvailability(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updates: { branch_id: string; is_available: boolean }[]) => {
      const response = await apiClient<BulkBranchProductAvailabilityResponse>(
        `/api/products/${productId}/branch-availability/bulk`,
        {
          method: 'PATCH',
          body: JSON.stringify({ updates }),
        },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update branch availability'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId, 'branch-availability'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Branch availability updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCreateVariant(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateVariantInput) => {
      const response = await apiClient<ProductVariantResponse>(`/api/products/${productId}/variants`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create variant'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Variant created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateVariant(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateVariantInput) => {
      const response = await apiClient<ProductVariantResponse>(`/api/products/${productId}/variants/${variantId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update variant'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Variant updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useLinkVariantFlavor(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkVariantFlavorInput) => {
      const response = await apiClient(`/api/products/${productId}/variants/${variantId}/flavors`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to link flavor'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      toast.success('Flavor linked');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (productId: string) => {
      const response = await apiClient<null>(`/api/products/${productId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete product'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteVariant(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variantId: string) => {
      const response = await apiClient<null>(`/api/products/${productId}/variants/${variantId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete variant'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Variant deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDeleteProductImage(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<{ image_url: null }>(`/api/products/${productId}/image`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove product image'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product image removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateVariantFlavor(productId: string, variantId: string, flavorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateVariantFlavorInput) => {
      const response = await apiClient(`/api/products/${productId}/variants/${variantId}/flavors/${flavorId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update flavor pricing'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      toast.success('Flavor pricing updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
