'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  BranchFlavorAvailabilityRow,
  CreateFlavorInput,
  FlavorDetailResponse,
  FlavorListResponse,
  UpdateFlavorInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

export interface FlavorFilters {
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_at' | 'updated_at' | 'display_order';
  sortOrder?: 'asc' | 'desc';
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

function buildQueryString(filters: FlavorFilters): string {
  const params = new URLSearchParams();
  if (filters.isActive !== undefined) params.set('is_active', String(filters.isActive));
  if (filters.search) params.set('search', filters.search);
  if (filters.sortBy) params.set('sort_by', filters.sortBy);
  if (filters.sortOrder) params.set('sort_order', filters.sortOrder);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useFlavors(filters: FlavorFilters = {}) {
  return useQuery({
    queryKey: ['flavors', filters],
    queryFn: async () => {
      const response = await apiClient<FlavorListResponse>(`/api/flavors?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load flavors'));
      return response.data;
    },
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useFlavor(flavorId: string | null | undefined) {
  return useQuery({
    queryKey: ['flavor', flavorId],
    queryFn: async () => {
      const response = await apiClient<FlavorDetailResponse>(`/api/flavors/${flavorId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load flavor'));
      return response.data;
    },
    enabled: Boolean(flavorId),
    staleTime: 30 * 1000,
  });
}

export function useCreateFlavor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFlavorInput) => {
      const response = await apiClient<FlavorDetailResponse>('/api/flavors', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create flavor'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flavors'] });
      toast.success('Flavor created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateFlavor(flavorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateFlavorInput) => {
      const response = await apiClient<FlavorDetailResponse>(`/api/flavors/${flavorId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update flavor'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flavor', flavorId] });
      void queryClient.invalidateQueries({ queryKey: ['flavors'] });
      toast.success('Flavor updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useBranchFlavorAvailability(flavorId: string | null | undefined) {
  return useQuery({
    queryKey: ['flavor', flavorId, 'branch-availability'],
    queryFn: async () => {
      const response = await apiClient<BranchFlavorAvailabilityRow[]>(`/api/flavors/${flavorId}/branch-availability`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch availability'));
      return response.data;
    },
    enabled: Boolean(flavorId),
    staleTime: 30 * 1000,
  });
}

export function useUpdateBranchFlavorAvailability(flavorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      branchId,
      isAvailable,
      unavailableReason,
    }: {
      branchId: string;
      isAvailable: boolean;
      unavailableReason?: string;
    }) => {
      const response = await apiClient<BranchFlavorAvailabilityRow>(`/api/flavors/${flavorId}/branch-availability/${branchId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_available: isAvailable, unavailable_reason: unavailableReason }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update branch flavor availability'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flavor', flavorId, 'branch-availability'] });
      void queryClient.invalidateQueries({ queryKey: ['flavor', flavorId] });
      void queryClient.invalidateQueries({ queryKey: ['flavors'] });
      toast.success('Branch flavor availability updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
