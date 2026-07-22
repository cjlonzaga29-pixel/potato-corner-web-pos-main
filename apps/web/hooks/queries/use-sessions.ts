'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

export interface SessionResponse {
  id: string;
  deviceId: string;
  deviceLabel: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export function useActiveSessions() {
  const { accessToken, isLoading } = useAuth();

  return useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const response = await apiClient<SessionResponse[]>('/api/auth/sessions');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load active sessions'));
      return response.data;
    },
    enabled: Boolean(accessToken) && !isLoading,
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const response = await apiClient<{ success: boolean }>(`/api/auth/sessions/${sessionId}`, { method: 'DELETE' });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to sign out that session'));
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Session signed out');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
