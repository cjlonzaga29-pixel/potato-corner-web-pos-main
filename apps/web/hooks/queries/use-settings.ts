'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  NotificationPreferences,
  ReceiptConfigResponse,
  SecurityPolicy,
  UpdateNotificationPreferencesInput,
  UpdateReceiptConfigInput,
  UpdateSecurityPolicyInput,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export function useSecurityPolicy() {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['settings', 'security'],
    queryFn: async () => {
      const response = await apiClient<SecurityPolicy>('/api/settings/security');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load security policy'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading,
  });
}

export function useUpdateSecurityPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateSecurityPolicyInput) => {
      const response = await apiClient<SecurityPolicy>('/api/settings/security', { method: 'PUT', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update security policy'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'security'] });
      toast.success('Security policy updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useNotificationPreferences() {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['settings', 'notifications'],
    queryFn: async () => {
      const response = await apiClient<NotificationPreferences>('/api/settings/notifications');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load notification preferences'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading,
  });
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateNotificationPreferencesInput) => {
      const response = await apiClient<NotificationPreferences>('/api/settings/notifications', {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update notification preferences'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'notifications'] });
      toast.success('Notification preferences updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useBranchReceiptConfig(branchId: string | null | undefined) {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['settings', 'receipt-config', branchId],
    queryFn: async () => {
      const response = await apiClient<ReceiptConfigResponse | null>(`/api/branches/${branchId}/receipt-config`);
      if (response.error) throw new Error(errorMessage(response, 'Failed to load receipt configuration'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading && !!branchId,
  });
}

export function useUpdateBranchReceiptConfig(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateReceiptConfigInput) => {
      const response = await apiClient<ReceiptConfigResponse>(`/api/branches/${branchId}/receipt-config`, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update receipt configuration'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'receipt-config', branchId] });
      toast.success('Receipt configuration updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
