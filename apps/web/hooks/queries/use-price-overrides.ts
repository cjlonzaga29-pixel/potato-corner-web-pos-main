'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  CreatePriceOverrideInput,
  PriceOverrideListResponse,
  PriceOverrideResponse,
  ReviewPriceOverrideInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export interface PriceOverrideFilters {
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

function buildQueryString(filters: PriceOverrideFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function usePriceOverrides(filters: PriceOverrideFilters = {}) {
  return useQuery({
    queryKey: ['price-overrides', filters],
    queryFn: async () => {
      const response = await apiClient<PriceOverrideListResponse>(`/api/price-overrides?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load price overrides'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function usePriceOverride(id: string | null | undefined) {
  const { data } = usePriceOverrides();
  return data?.overrides.find((o) => o.id === id);
}

/** Keeps pending price-override lists (dashboard KPI, sidebar badge, approvals queue) in sync with submissions from any branch, without a manual refresh. */
export function usePriceOverrideRealtimeSync(): void {
  useRealtimeInvalidate([SOCKET_EVENTS.PRICE_OVERRIDE_SUBMITTED], [['price-overrides']]);
}

export function useSubmitPriceOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePriceOverrideInput) => {
      const response = await apiClient<PriceOverrideResponse>('/api/price-overrides', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit price override request'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['price-overrides'] });
      toast.success('Price override request submitted for approval');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useReviewPriceOverride(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReviewPriceOverrideInput) => {
      const response = await apiClient<PriceOverrideResponse>(`/api/price-overrides/${id}/review`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to review price override request'));
      return response.data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['price-overrides'] });
      toast.success(data.status === 'approved' ? 'Price override approved' : 'Price override rejected');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Keeps the price-override list in sync with submissions and reviews made from any other session, without a manual refresh. usePriceOverride derives from usePriceOverrides, so a single ['price-overrides'] invalidation covers both. */
export function usePriceOverridesRealtimeSync(): void {
  useRealtimeInvalidate([SOCKET_EVENTS.PRICE_OVERRIDE_SUBMITTED, SOCKET_EVENTS.PRICE_OVERRIDE_REVIEWED], [['price-overrides']]);
}
