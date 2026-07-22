'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

export interface TwoFactorStatus {
  enabled: boolean;
  enrolledAt: string | null;
}

export interface Enroll2FAResponse {
  qrCodeDataUrl: string;
  secret: string;
}

export interface BackupCodesResponse {
  backupCodes: string[];
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export function use2FAStatus() {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['2fa-status'],
    queryFn: async () => {
      const response = await apiClient<TwoFactorStatus>('/api/auth/2fa/status');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load 2FA status'));
      return response.data;
    },
    enabled: Boolean(accessToken) && !isLoading,
  });
}

export function useEnroll2FA() {
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<Enroll2FAResponse>('/api/auth/2fa/enroll', { method: 'POST' });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to start 2FA setup'));
      return response.data;
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useConfirm2FA() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const response = await apiClient<BackupCodesResponse>('/api/auth/2fa/confirm', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Invalid authentication code'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['2fa-status'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useDisable2FA() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { currentPassword: string; token: string }) => {
      const response = await apiClient<{ success: boolean }>('/api/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ current_password: payload.currentPassword, token: payload.token }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to disable 2FA'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['2fa-status'] });
      toast.success('Two-factor authentication disabled');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useRegenerateBackupCodes() {
  return useMutation({
    mutationFn: async (token: string) => {
      const response = await apiClient<BackupCodesResponse>('/api/auth/2fa/regenerate-backup-codes', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to regenerate backup codes'));
      return response.data;
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
