'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateProductCategoryInput, ProductCategoryListResponse, ProductCategoryResponse, UpdateProductCategoryInput } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

export interface ProductCategoryFilters {
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'code' | 'sort_order' | 'created_at';
  sortOrder?: 'asc' | 'desc';
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: ProductCategoryFilters): string {
  const params = new URLSearchParams();
  if (filters.isActive !== undefined) params.set('is_active', String(filters.isActive));
  if (filters.search) params.set('search', filters.search);
  if (filters.sortBy) params.set('sort_by', filters.sortBy);
  if (filters.sortOrder) params.set('sort_order', filters.sortOrder);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useProductCategories(filters: ProductCategoryFilters = {}) {
  return useQuery({
    queryKey: ['product-categories', filters],
    queryFn: async () => {
      const response = await apiClient<ProductCategoryListResponse>(`/api/product-categories?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load product categories'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useCreateProductCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductCategoryInput) => {
      const response = await apiClient<ProductCategoryResponse>('/api/product-categories', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create product category'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-categories'] });
      toast.success('Product category created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProductCategory(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductCategoryInput) => {
      const response = await apiClient<ProductCategoryResponse>(`/api/product-categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update product category'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-categories'] });
      toast.success('Product category updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
