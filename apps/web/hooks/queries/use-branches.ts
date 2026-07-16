'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  AssignSupervisorInput,
  BranchAssignmentResponse,
  BranchListResponse,
  BranchResponse,
  BranchStatsResponse,
  BranchStatus,
  ChangeBranchStatusInput,
  CreateBranchInput,
  UpdateBranchInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

export interface BranchFilters {
  status?: BranchStatus;
  city?: string;
  search?: string;
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

function buildQueryString(filters: BranchFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.city) params.set('city', filters.city);
  if (filters.search) params.set('search', filters.search);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

export function useBranches(filters: BranchFilters = {}) {
  return useQuery({
    queryKey: ['branches', filters],
    queryFn: async () => {
      const response = await apiClient<BranchListResponse>(`/api/branches?${buildQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branches'));
      return response.data;
    },
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

export function useBranch(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch', branchId],
    queryFn: async () => {
      const response = await apiClient<BranchResponse>(`/api/branches/${branchId}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 30 * 1000,
  });
}

export function useBranchAssignments(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch', branchId, 'assignments'],
    queryFn: async () => {
      const response = await apiClient<BranchAssignmentResponse[]>(`/api/branches/${branchId}/assignments`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load assignments'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 30 * 1000,
  });
}

export function useBranchStats(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['branch', branchId, 'stats'],
    queryFn: async () => {
      const response = await apiClient<BranchStatsResponse>(`/api/branches/${branchId}/stats`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch stats'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
}

/** Keeps branch lists/dashboards in sync with status changes and supervisor (re)assignments recorded from any other session, without a manual refresh. */
export function useBranchRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.BRANCH_STATUS_CHANGED, SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED],
    [['branches'], ['branch']],
  );
}

export function useCreateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBranchInput) => {
      const response = await apiClient<BranchResponse>('/api/branches', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to create branch'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      toast.success('Branch created');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUpdateBranch(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateBranchInput) => {
      const response = await apiClient<BranchResponse>(`/api/branches/${branchId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update branch'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branch', branchId] });
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      toast.success('Branch updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useChangeBranchStatus(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChangeBranchStatusInput) => {
      const response = await apiClient<BranchResponse>(`/api/branches/${branchId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to change branch status'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      void queryClient.invalidateQueries({ queryKey: ['branch', branchId] });
      toast.success('Branch status updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useAssignSupervisor(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignSupervisorInput) => {
      const response = await apiClient<BranchAssignmentResponse>(`/api/branches/${branchId}/assignments`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to assign supervisor'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branch', branchId, 'assignments'] });
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      toast.success('Supervisor assigned');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useRemoveSupervisor(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const response = await apiClient<null>(`/api/branches/${branchId}/assignments/${userId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to remove supervisor'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branch', branchId, 'assignments'] });
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      toast.success('Supervisor removed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Keeps the branch list/detail views in sync with status changes and supervisor assignment changes made from any other session, without a manual refresh. */
export function useBranchesRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.BRANCH_STATUS_CHANGED, SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED],
    [['branches'], ['branch']],
  );
}
