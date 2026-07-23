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

export interface BranchAccountOverview {
  assignment_id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  branch_id: string;
  branch_name: string;
  branch_code: string;
}

/** Cross-branch roster (super_admin only) — GET /api/branches/accounts. */
export function useBranchAccountsOverview() {
  return useQuery({
    queryKey: ['branches', 'accounts-overview'],
    queryFn: async () => {
      const response = await apiClient<BranchAccountOverview[]>('/api/branches/accounts');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch accounts'));
      return response.data;
    },
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

export interface BranchStatsOverview {
  branchId: string;
  activeShiftsCount: number;
  activeStaffCount: number;
  todayRevenue: number;
  todayGrossSales: number;
  todayVat: number;
  todayExpenses: number;
  todayNetProfit: number;
  todayTransactionCount: number;
  lowStockIngredientCount: number;
}

/**
 * Every branch's live stats in one call — GET /api/branches/stats, used by
 * the dashboard branch grid and KPI row. Pass a branchId to scope the result
 * to a single branch (still returned as a length-1 array); omit it for the
 * existing all-accessible-branches behavior.
 */
export function useAllBranchStats(branchId?: string) {
  return useQuery({
    queryKey: ['branches', 'all-stats', branchId ?? 'all'],
    queryFn: async () => {
      const query = branchId ? `?branch_id=${branchId}` : '';
      const response = await apiClient<BranchStatsOverview[]>(`/api/branches/stats${query}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load branch stats'));
      return response.data;
    },
    staleTime: 30_000,
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
    [
      SOCKET_EVENTS.BRANCH_CREATED,
      SOCKET_EVENTS.BRANCH_STATUS_CHANGED,
      SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED,
      SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED,
    ],
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

export function useUploadBranchGcashQr(branchId: string) {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.set('qr', file);
      const response = await apiClient<{ url: string; key: string }>(`/api/branches/${branchId}/gcash-qr`, {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload QR image'));
      return response.data;
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export interface BulkAssignGcashQrResult {
  successful: Array<{ branchId: string; gcashQrUrl: string }>;
  failed: Array<{ branchId: string; error: string }>;
}

/** POST /api/branches/gcash-qr/bulk-assign — one QR image applied to many branches in a single admin action. */
export function useBulkAssignGcashQr() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, branchIds }: { file: File; branchIds: string[] }) => {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('branchIds', JSON.stringify(branchIds));
      const response = await apiClient<BulkAssignGcashQrResult>('/api/branches/gcash-qr/bulk-assign', {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to assign GCash QR'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      void queryClient.invalidateQueries({ queryKey: ['branch'] });
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
