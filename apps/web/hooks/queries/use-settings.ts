'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  NotificationPreferences,
  DiscountPolicyResponse,
  UpdateNotificationPreferencesInput,
  UpdateDiscountPolicyInput,
  WorkHoursPolicyResponse,
  UpdateWorkHoursPolicyInput,
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

/**
 * P3D-P4 — the configured regular-shift length (hours) before overtime
 * accrues, resolved server-side by settingsService.getRegularShiftMinutes()
 * for both clock-out and manual-override attendance calculations. Readable
 * by every role (allRoles) so attendance views can label Regular/OT
 * consistently; only Super Admin can write it (adminOnly on the PUT route).
 */
export function useWorkHoursPolicy() {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['settings', 'work-hours'],
    queryFn: async () => {
      const response = await apiClient<WorkHoursPolicyResponse>('/api/settings/work-hours');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load work hours settings'));
      return response.data;
    },
    enabled: !!accessToken && !isLoading,
  });
}

export function useUpdateWorkHoursPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateWorkHoursPolicyInput) => {
      const response = await apiClient<WorkHoursPolicyResponse>('/api/settings/work-hours', { method: 'PUT', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update work hours settings'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'work-hours'] });
      toast.success('Work hours settings updated');
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

