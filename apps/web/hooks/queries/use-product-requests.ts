'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  CreateProductRequestInput,
  ProductRequestListResponse,
  ProductRequestResponse,
  ReviewProductRequestInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export interface ProductRequestFilters {
  status?: 'pending' | 'approved' | 'rejected';
  branch_id?: string;
  page?: number;
  limit?: number;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: ProductRequestFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useProductRequests(filters: ProductRequestFilters = {}) {
  return useQuery({
    queryKey: ['product-requests', filters],
    queryFn: async () => {
      const response = await apiClient<ProductRequestListResponse>(`/api/product-requests?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load product requests'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useProductRequest(id: string | null | undefined) {
  return useQuery({
    queryKey: ['product-request', id],
    queryFn: async () => {
      const response = await apiClient<ProductRequestResponse>(`/api/product-requests/${id}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load product request'));
      return response.data;
    },
    enabled: Boolean(id),
    staleTime: 15 * 1000,
  });
}

/** Keeps pending product-request lists (dashboard KPI, sidebar badge, approvals queue) in sync with submissions from any branch, without a manual refresh. */
export function useProductRequestRealtimeSync(): void {
  useRealtimeInvalidate([SOCKET_EVENTS.PRODUCT_REQUEST_SUBMITTED], [['product-requests']]);
}

export function useSubmitProductRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductRequestInput) => {
      const response = await apiClient<ProductRequestResponse>('/api/product-requests', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit product request'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['product-requests'] });
      toast.success('Product request submitted for approval');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useReviewProductRequest(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReviewProductRequestInput) => {
      const response = await apiClient<ProductRequestResponse>(`/api/product-requests/${id}/review`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to review product request'));
      return response.data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['product-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['product-request', id] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success(data.status === 'approved' ? 'Product request approved' : 'Product request rejected');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Keeps the product-request list/detail views in sync with submissions and reviews made from any other session, without a manual refresh. */
export function useProductRequestsRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.PRODUCT_REQUEST_SUBMITTED, SOCKET_EVENTS.PRODUCT_REQUEST_REVIEWED],
    [['product-requests'], ['product-request']],
  );
}
