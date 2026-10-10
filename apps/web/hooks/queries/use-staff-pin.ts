'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  SetStaffPinInput,
  StaffPinStatusResponse,
  StaffPinVerifyResponse,
  VerifyStaffPinInput,
  StaffPinVerifyPosResponse,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Query key factory — shared between useStaffPinStatus and the set/revoke mutations' invalidation below. */
function staffPinStatusKey(userId: string | null | undefined) {
  return ['staff-pin-status', userId] as const;
}

/** POS-PERF-P29 — set or reset a staff member's PIN (supervisor/admin provisioning, or the branch-terminal self-service flow). */
export function useSetStaffPin(userId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetStaffPinInput) => {
      const response = await apiClient<{ user_id: string; set_at: string }>(`/api/staff-pin/${userId}/pin`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to set PIN'));
      return response.data;
    },
    onSuccess: () => {
      toast.success('PIN saved');
      void queryClient.invalidateQueries({ queryKey: staffPinStatusKey(userId) });
    },
  });
}

export function useRevokeStaffPin(userId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<{ revoked: boolean }>(`/api/staff-pin/${userId}/pin/revoke`, { method: 'POST' });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to revoke PIN'));
      return response.data;
    },
    onSuccess: () => {
      toast.success('PIN deactivated');
      void queryClient.invalidateQueries({ queryKey: staffPinStatusKey(userId) });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export async function fetchStaffPinStatus(userId: string): Promise<StaffPinStatusResponse | null> {
  const response = await apiClient<StaffPinStatusResponse>(`/api/staff-pin/${userId}`);
  return response.data;
}

/** Supervisor Employees list — per-row PIN status (Not Set / Active / Inactive). Only meaningful for staff-role rows; callers gate `enabled` on that. */
export function useStaffPinStatus(userId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: staffPinStatusKey(userId),
    queryFn: () => fetchStaffPinStatus(userId as string),
    enabled: enabled && !!userId,
  });
}

/**
 * Verify a PIN for a draft operation and mint a short-lived verification
 * token bound to the exact draft fields. Never cached as a query — this is
 * a one-shot action the form triggers on a button press, and a stale cached
 * token would be worse than useless (it would be rejected server-side the
 * instant the draft changes anyway, by design).
 */
export function useVerifyStaffPin(branchId: string | null | undefined) {
  return useMutation({
    mutationFn: async (input: VerifyStaffPinInput) => {
      const response = await apiClient<StaffPinVerifyResponse>(`/api/staff-pin/branches/${branchId}/verify`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Invalid PIN'));
      return response.data;
    },
  });
}

/**
 * POS-PERF-P30 — verify a PIN to resolve POS terminal cashier identity /
 * staff clock-in (dedicated `pos` purpose, never shared with the inventory
 * verify above). Not cached, same one-shot rationale as useVerifyStaffPin.
 */
export function useVerifyPosPin(branchId: string | null | undefined) {
  return useMutation({
    mutationFn: async (pin: string) => {
      const response = await apiClient<StaffPinVerifyPosResponse>(`/api/staff-pin/branches/${branchId}/verify-pos`, {
        method: 'POST',
        body: JSON.stringify({ pin }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Invalid PIN'));
      return response.data;
    },
  });
}
