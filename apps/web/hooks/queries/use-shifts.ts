'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ApproveVarianceInput,
  CloseShiftInput,
  OpenShiftInput,
  ShiftCloseResponse,
  ShiftListResponse,
  ShiftResponse,
  ShiftSummaryResponse,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useShiftStore } from '@/stores/shift.store';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** The branch's currently open shift, or null once none is active — 404 from the API is treated as "no shift", not an error state. */
export function useCurrentShift(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['current-shift', branchId],
    queryFn: async () => {
      const response = await apiClient<ShiftResponse>(`/api/cash/current?branch_id=${branchId}`);
      if (!response.data) {
        if (typeof response.error === 'object' && response.error?.code === 'SHIFT_NOT_FOUND') return null;
        throw new Error(errorMessage(response, 'Failed to load current shift'));
      }
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useShift(shiftId: string | null | undefined) {
  return useQuery({
    queryKey: ['shift', shiftId],
    queryFn: async () => {
      const response = await apiClient<ShiftResponse>(`/api/cash/${shiftId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load shift'));
      return response.data;
    },
    enabled: Boolean(shiftId),
  });
}

export function useShiftSummary(shiftId: string | null | undefined) {
  return useQuery({
    queryKey: ['shift-summary', shiftId],
    queryFn: async () => {
      const response = await apiClient<ShiftSummaryResponse>(`/api/cash/${shiftId}/summary`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load shift summary'));
      return response.data;
    },
    enabled: Boolean(shiftId),
    // Matches useCurrentShift's cadence — meaningful for an OPEN shift's
    // live preview; a closed/flagged shift's summary never changes, but a
    // short staleTime is harmless there too.
    staleTime: 10 * 1000,
  });
}

export interface ShiftListFilters {
  branch_id?: string;
  status?: 'active' | 'closed' | 'flagged';
  page?: number;
  limit?: number;
}

function buildShiftsQueryString(filters: ShiftListFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.status) params.set('status', filters.status);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useShifts(filters: ShiftListFilters = {}) {
  return useQuery({
    queryKey: ['shifts', filters],
    queryFn: async () => {
      const response = await apiClient<ShiftListResponse>(`/api/cash?${buildShiftsQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load shifts'));
      return response.data;
    },
    placeholderData: keepPreviousData,
  });
}

function invalidateShifts(queryClient: ReturnType<typeof useQueryClient>, branchId: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: ['current-shift', branchId] });
  void queryClient.invalidateQueries({ queryKey: ['shifts'] });
}

export function useOpenShift(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: OpenShiftInput) => {
      const response = await apiClient<ShiftResponse>('/api/cash/open', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to open shift'));
      return response.data;
    },
    onSuccess: (shift) => {
      useShiftStore.getState().setCurrentShift(shift);
      invalidateShifts(queryClient, branchId);
      toast.success('Shift opened');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCloseShift(branchId: string | null | undefined, shiftId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CloseShiftInput) => {
      const response = await apiClient<ShiftCloseResponse>(`/api/cash/${shiftId}/close`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to close shift'));
      return response.data;
    },
    onSuccess: (shift) => {
      useShiftStore.getState().clearShift();
      invalidateShifts(queryClient, branchId);
      queryClient.setQueryData(['shift', shiftId], shift);
      void queryClient.invalidateQueries({ queryKey: ['shift-summary', shiftId] });
      toast.success(shift.status === 'flagged' ? 'Shift closed — pending variance review' : 'Shift closed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useApproveVariance(shiftId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApproveVarianceInput) => {
      const response = await apiClient<ShiftResponse>(`/api/cash/${shiftId}/approve-variance`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to record the variance decision'));
      return response.data;
    },
    onSuccess: (shift) => {
      queryClient.setQueryData(['shift', shiftId], shift);
      void queryClient.invalidateQueries({ queryKey: ['shifts'] });
      void queryClient.invalidateQueries({ queryKey: ['shift-summary', shiftId] });
      toast.success(shift.variance_approved ? 'Variance approved' : 'Variance rejected');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
