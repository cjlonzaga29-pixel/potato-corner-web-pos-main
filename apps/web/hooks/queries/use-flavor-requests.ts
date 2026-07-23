'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  CreateFlavorRequestInput,
  FlavorRequestListResponse,
  FlavorRequestResponse,
  ReviewFlavorRequestInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export interface FlavorRequestFilters {
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

function buildQueryString(filters: FlavorRequestFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useFlavorRequests(filters: FlavorRequestFilters = {}) {
  return useQuery({
    queryKey: ['flavor-requests', filters],
    queryFn: async () => {
      const response = await apiClient<FlavorRequestListResponse>(`/api/flavor-requests?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load flavor requests'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useFlavorRequest(id: string | null | undefined) {
  return useQuery({
    queryKey: ['flavor-request', id],
    queryFn: async () => {
      const response = await apiClient<FlavorRequestResponse>(`/api/flavor-requests/${id}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load flavor request'));
      return response.data;
    },
    enabled: Boolean(id),
    staleTime: 15 * 1000,
  });
}

export function useSubmitFlavorRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFlavorRequestInput) => {
      const response = await apiClient<FlavorRequestResponse>('/api/flavor-requests', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to submit flavor request'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flavor-requests'] });
      toast.success('Flavor request submitted for approval');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useReviewFlavorRequest(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReviewFlavorRequestInput) => {
      const response = await apiClient<FlavorRequestResponse>(`/api/flavor-requests/${id}/review`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to review flavor request'));
      return response.data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['flavor-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['flavor-request', id] });
      void queryClient.invalidateQueries({ queryKey: ['flavors'] });
      toast.success(data.status === 'approved' ? 'Flavor request approved' : 'Flavor request rejected');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Keeps the flavor-request list/detail views in sync with submissions and reviews made from any other session, without a manual refresh. */
export function useFlavorRequestsRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.FLAVOR_REQUEST_SUBMITTED, SOCKET_EVENTS.FLAVOR_REQUEST_REVIEWED],
    [['flavor-requests'], ['flavor-request']],
  );
}
