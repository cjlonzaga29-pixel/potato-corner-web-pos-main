'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import type {
  CorrectInventoryApprovalRequestInput,
  InventoryApprovalRequestDetailResponse,
  InventoryApprovalRequestListResponse,
  InventoryApprovalRequestResponse,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export type InventoryApprovalStatusFilter = 'PENDING' | 'APPROVED' | 'RETURNED';

function queryKey(branchId: string | null | undefined, status: InventoryApprovalStatusFilter) {
  return ['inventory-approvals', branchId, status] as const;
}

function invalidateApprovals(queryClient: ReturnType<typeof useQueryClient>, branchId: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: ['inventory-approvals', branchId] });
  void queryClient.invalidateQueries({ queryKey: ['branch-inventory-stock', branchId] });
}

export function useInventoryApprovals(branchId: string | null | undefined, status: InventoryApprovalStatusFilter) {
  return useQuery({
    queryKey: queryKey(branchId, status),
    queryFn: async () => {
      const params = new URLSearchParams({ status, limit: '100' });
      if (branchId) params.set('branch_id', branchId);
      const response = await apiClient<InventoryApprovalRequestListResponse>(`/api/inventory-approvals?${params.toString()}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load approval requests'));
      return response.data;
    },
    enabled: Boolean(branchId),
    staleTime: 10 * 1000,
  });
}

export function useInventoryApprovalDetail(id: string | null) {
  return useQuery({
    queryKey: ['inventory-approvals', 'detail', id],
    queryFn: async () => {
      const response = await apiClient<InventoryApprovalRequestDetailResponse>(`/api/inventory-approvals/${id}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load approval request'));
      return response.data;
    },
    enabled: Boolean(id),
  });
}

/** Keeps the three review-queue tabs in sync with approvals recorded from any other device, without a manual refresh. */
export function useInventoryApprovalRealtimeSync(branchId: string | null | undefined): void {
  useRealtimeInvalidate([SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED], [['inventory-approvals', branchId]]);
}

export function useApproveInventoryApprovalRequest(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient<InventoryApprovalRequestResponse>(`/api/inventory-approvals/${id}/approve`, { method: 'POST' });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to approve this request'));
      return response.data;
    },
    onSuccess: () => {
      invalidateApprovals(queryClient, branchId);
      toast.success('Approved — stock has been updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useReturnInventoryApprovalRequest(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const response = await apiClient<InventoryApprovalRequestResponse>(`/api/inventory-approvals/${id}/return`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to return this request'));
      return response.data;
    },
    onSuccess: () => {
      invalidateApprovals(queryClient, branchId);
      toast.success('Returned for correction');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useCorrectInventoryApprovalRequest(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: CorrectInventoryApprovalRequestInput }) => {
      const response = await apiClient<InventoryApprovalRequestResponse>(`/api/inventory-approvals/${id}/correct`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to resubmit this request'));
      return response.data;
    },
    onSuccess: () => {
      invalidateApprovals(queryClient, branchId);
      toast.success('Resubmitted for review');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useUploadInventoryApprovalProof(branchId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const formData = new FormData();
      formData.set('proof', file);
      const response = await apiClient<InventoryApprovalRequestResponse>(`/api/inventory-approvals/${id}/proof`, {
        method: 'POST',
        body: formData,
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to upload the proof photo'));
      return response.data;
    },
    onSuccess: () => {
      invalidateApprovals(queryClient, branchId);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
