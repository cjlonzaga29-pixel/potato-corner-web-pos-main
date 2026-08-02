'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AssignVariantOptionGroupInput,
  CreateProductOptionGroupInput,
  CreateProductOptionInput,
  ProductOptionAssignedVariantResponse,
  ProductOptionGroupDetailResponse,
  ProductOptionGroupListResponse,
  ProductOptionGroupResponse,
  ProductOptionResponse,
  UpdateProductOptionGroupInput,
  UpdateProductOptionInput,
  UpdateVariantOptionGroupInput,
  VariantOptionGroupResponse,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

export interface OptionGroupFilters {
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

function buildQueryString(filters: OptionGroupFilters): string {
  const params = new URLSearchParams();
  if (filters.isActive !== undefined) params.set('is_active', String(filters.isActive));
  if (filters.search) params.set('search', filters.search);
  if (filters.sortBy) params.set('sort_by', filters.sortBy);
  if (filters.sortOrder) params.set('sort_order', filters.sortOrder);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useProductOptionGroups(filters: OptionGroupFilters = {}) {
  return useQuery({
    queryKey: ['product-option-groups', filters],
    queryFn: async () => {
      const response = await apiClient<ProductOptionGroupListResponse>(`/api/product-options?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load option groups'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useProductOptionGroup(groupId: string | null | undefined) {
  return useQuery({
    queryKey: ['product-option-group', groupId],
    queryFn: async () => {
      const response = await apiClient<ProductOptionGroupDetailResponse>(`/api/product-options/${groupId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load option group'));
      return response.data;
    },
    enabled: Boolean(groupId),
    staleTime: 30 * 1000,
  });
}

export function useCreateProductOptionGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductOptionGroupInput) => {
      const response = await apiClient<ProductOptionGroupResponse>('/api/product-options', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create option group'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-option-groups'] });
      toast.success('Option group created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProductOptionGroup(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductOptionGroupInput) => {
      const response = await apiClient<ProductOptionGroupResponse>(`/api/product-options/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update option group'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-option-group', groupId] });
      void queryClient.invalidateQueries({ queryKey: ['product-option-groups'] });
      toast.success('Option group updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCreateProductOption(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductOptionInput) => {
      const response = await apiClient<ProductOptionResponse>(`/api/product-options/${groupId}/options`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create option'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-option-group', groupId] });
      void queryClient.invalidateQueries({ queryKey: ['product-option-groups'] });
      toast.success('Option created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateProductOption(groupId: string, optionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductOptionInput) => {
      const response = await apiClient<ProductOptionResponse>(`/api/product-options/${groupId}/options/${optionId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update option'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-option-group', groupId] });
      toast.success('Option updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

// --- Variant <-> Option Group assignment (R6) ---

export function useVariantOptionGroups(productId: string | null | undefined, variantId: string | null | undefined) {
  return useQuery({
    queryKey: ['variant-option-groups', variantId],
    queryFn: async () => {
      const response = await apiClient<{ option_groups: VariantOptionGroupResponse[] }>(
        `/api/products/${productId}/variants/${variantId}/option-groups`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load variant option groups'));
      return response.data.option_groups;
    },
    enabled: Boolean(productId) && Boolean(variantId),
    staleTime: 30 * 1000,
  });
}

export function useAssignVariantOptionGroup(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignVariantOptionGroupInput) => {
      const response = await apiClient<VariantOptionGroupResponse>(`/api/products/${productId}/variants/${variantId}/option-groups`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to assign option group'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['variant-option-groups', variantId] });
      toast.success('Option group assigned');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateVariantOptionGroup(productId: string, variantId: string, assignmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateVariantOptionGroupInput) => {
      const response = await apiClient<VariantOptionGroupResponse>(
        `/api/products/${productId}/variants/${variantId}/option-groups/${assignmentId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update option group assignment'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['variant-option-groups', variantId] });
      toast.success('Option group assignment updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Reverse lookup for the Edit Option dialog's Inventory Deduction section: which variants use this option. */
export function useProductOptionAssignedVariants(groupId: string | null | undefined, optionId: string | null | undefined) {
  return useQuery({
    queryKey: ['product-option-assigned-variants', groupId, optionId],
    queryFn: async () => {
      const response = await apiClient<{ variants: ProductOptionAssignedVariantResponse[] }>(
        `/api/product-options/${groupId}/options/${optionId}/variants`,
      );
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load assigned variants'));
      return response.data.variants;
    },
    enabled: Boolean(groupId) && Boolean(optionId),
    staleTime: 30 * 1000,
  });
}

export function useUnassignVariantOptionGroup(productId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (assignmentId: string) => {
      const response = await apiClient<null>(`/api/products/${productId}/variants/${variantId}/option-groups/${assignmentId}`, {
        method: 'DELETE',
      });
      if (response.error) throw new Error(errorMessage(response, 'Failed to unassign option group'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['variant-option-groups', variantId] });
      toast.success('Option group unassigned');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
