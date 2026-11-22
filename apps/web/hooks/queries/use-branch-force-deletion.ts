'use client';

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type {
  BranchClosureItemList,
  ForceDeleteBranchInput,
  ForceDeletionPlan,
  ForceDeletionStatus,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { BranchRequestError } from '@/hooks/queries/use-branches';

/**
 * POS-PERF-P68 — Force Delete Branch (Super Admin). The plan is read fresh
 * every time the dialog opens; the confirmation it carries is bound to this
 * actor, branch, version and exact plan.
 */

interface ApiErrorShape {
  error: { code: string; message?: string; details?: unknown } | string | null;
}

function toError(response: ApiErrorShape, fallback: string): BranchRequestError {
  const error = response.error;
  if (!error) return new BranchRequestError(fallback, null, null);
  if (typeof error === 'string') return new BranchRequestError(error, null, null);
  return new BranchRequestError(error.message ?? error.code, error.code, error.details ?? null);
}

export function useForceDeletionPlan(branchId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['branch', branchId, 'force-deletion-plan'],
    queryFn: async () => {
      const response = await apiClient<ForceDeletionPlan>(
        `/api/branches/${branchId}/force-deletion-plan`,
      );
      if (!response.data) throw toError(response, 'Failed to prepare Force Delete');
      return response.data;
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export async function startForceDeletion(
  branchId: string,
  input: ForceDeleteBranchInput,
): Promise<ForceDeletionStatus> {
  const response = await apiClient<ForceDeletionStatus>(`/api/branches/${branchId}/force-delete`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.data) throw toError(response, 'Force Delete failed');
  return response.data;
}

/** Reads (and on the server, advances) an operation. A 404 means it never started. */
export async function fetchForceDeletionStatus(
  operationId: string,
): Promise<ForceDeletionStatus | null> {
  const response = await apiClient<ForceDeletionStatus>(
    `/api/branches/force-deletions/${operationId}`,
  );
  if (response.data) return response.data;
  const error = toError(response, 'Could not read the Force Delete status');
  if (error.code === 'FORCE_DELETION_NOT_FOUND') return null;
  throw error;
}

export async function abortForceDeletion(operationId: string): Promise<ForceDeletionStatus> {
  const response = await apiClient<ForceDeletionStatus>(
    `/api/branches/force-deletions/${operationId}/abort`,
    { method: 'POST' },
  );
  if (!response.data) throw toError(response, 'Could not stop the Force Delete');
  return response.data;
}

export interface ClosureItemFilters {
  branchId?: string;
  reconciled?: boolean;
  page?: number;
  limit?: number;
}

export function useClosureItems(filters: ClosureItemFilters) {
  return useQuery({
    queryKey: ['branch-closure-items', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.branchId) params.set('branch_id', filters.branchId);
      if (filters.reconciled !== undefined) params.set('reconciled', String(filters.reconciled));
      params.set('page', String(filters.page ?? 1));
      params.set('limit', String(filters.limit ?? 25));
      const response = await apiClient<BranchClosureItemList>(
        `/api/branches/closure-items?${params.toString()}`,
      );
      if (!response.data) throw toError(response, 'Failed to load unresolved items');
      return response.data;
    },
    placeholderData: keepPreviousData,
  });
}

export function useReconcileClosureItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, note }: { itemId: string; note: string }) => {
      const response = await apiClient<{ reconciled: true }>(
        `/api/branches/closure-items/${itemId}/reconcile`,
        {
          method: 'POST',
          body: JSON.stringify({ note }),
        },
      );
      if (!response.data) throw toError(response, 'Failed to mark as reconciled');
      return response.data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['branch-closure-items'] }),
  });
}
