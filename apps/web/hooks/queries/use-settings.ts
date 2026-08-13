'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  NotificationPreferences,
  PaymentMethodConfigResponse,
  ReceiptConfigResponse,
  SecurityPolicy,
  DiscountPolicyResponse,
  UpdateNotificationPreferencesInput,
  UpdatePaymentMethodConfigInput,
  UpdateReceiptConfigInput,
  UpdateSecurityPolicyInput,
  UpdateDiscountPolicyInput,
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

/**
 * Task 209.xx — the centrally configured PWD/Senior Citizen/Employee/
 * Promotional percentages. Read by both the POS dropdown (terminal/page.tsx,
 * to render "PWD (10%)" etc.) and Discount Settings (readable by every
 * role — cashier/staff/branch are READ ONLY, enforced server-side by the
 * PUT route's adminOrSupervisor gate, not by hiding this query).
 */
export function useDiscountPolicy() {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['settings', 'discount-policy'],
    queryFn: async () => {
      const response = await apiClient<DiscountPolicyResponse>('/api/settings/discount-policy');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load discount settings'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading,
  });
}

export function useUpdateDiscountPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateDiscountPolicyInput) => {
      const response = await apiClient<DiscountPolicyResponse>('/api/settings/discount-policy', { method: 'PUT', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update discount settings'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'discount-policy'] });
      toast.success('Discount settings updated');
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

export function usePaymentMethodConfig(branchId: string | null | undefined) {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['settings', 'payment-methods', branchId],
    queryFn: async () => {
      const response = await apiClient<PaymentMethodConfigResponse | null>(`/api/branches/${branchId}/payment-methods`);
      if (response.error) throw new Error(errorMessage(response, 'Failed to load payment method configuration'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading && !!branchId,
  });
}

export function useUpdatePaymentMethodConfig(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePaymentMethodConfigInput) => {
      const response = await apiClient<PaymentMethodConfigResponse>(`/api/branches/${branchId}/payment-methods`, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update payment method configuration'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'payment-methods', branchId] });
      toast.success('Payment method configuration updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
