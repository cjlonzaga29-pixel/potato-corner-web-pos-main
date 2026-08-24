'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  NotificationPreferences,
  DiscountPolicyResponse,
  UpdateNotificationPreferencesInput,
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

