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

export interface Verify2FASessionResponse {
  access_token: string;
  user: {
    id: string;
    role: 'super_admin' | 'supervisor' | 'branch' | 'staff';
    email: string;
    first_name: string;
    last_name: string;
    branch_ids: string[];
  };
}

export interface Verify2FABackupCodeResponse extends Verify2FASessionResponse {
  backup_codes_remaining: number;
  low_backup_codes_warning: boolean;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Error code from the API response, when present — lets callers branch on failure kind (e.g. an expired challenge) without string-matching the display message. */
function errorCode(response: ApiErrorShape): string | undefined {
  return typeof response.error === 'object' ? response.error?.code : undefined;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
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

// -- Step 11b Phase 2: 2FA login verification --------------------------------
// No onError toast here — the login page renders inline error state itself
// (matching the existing password-login error handling in login-form.tsx),
// since a toast plus an inline message would duplicate the same failure.

export function useVerify2FALogin() {
  return useMutation({
    mutationFn: async (payload: { challengeToken: string; totpCode: string; deviceId: string }) => {
      const response = await apiClient<Verify2FASessionResponse>('/api/auth/2fa/verify-login', {
        method: 'POST',
        body: JSON.stringify({
          challenge_token: payload.challengeToken,
          totp_code: payload.totpCode,
          device_id: payload.deviceId,
        }),
      });
      if (!response.data) throw new ApiRequestError(errorMessage(response, 'Invalid authentication code'), errorCode(response));
      return response.data;
    },
  });
}

export function useVerify2FABackupCode() {
  return useMutation({
    mutationFn: async (payload: { challengeToken: string; backupCode: string; deviceId: string }) => {
      const response = await apiClient<Verify2FABackupCodeResponse>('/api/auth/2fa/verify-backup-code', {
        method: 'POST',
        body: JSON.stringify({
          challenge_token: payload.challengeToken,
          backup_code: payload.backupCode,
          device_id: payload.deviceId,
        }),
      });
      if (!response.data) throw new ApiRequestError(errorMessage(response, 'Invalid backup code'), errorCode(response));
      return response.data;
    },
  });
}
