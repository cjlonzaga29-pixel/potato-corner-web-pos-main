'use client';

import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';

interface UpdateProfileResponse {
  user: {
    id: string;
    role: string;
    email: string | null;
    first_name: string;
    last_name: string;
    branch_ids: string[];
    must_change_password: boolean;
  };
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/**
 * Self-service display-name update. On success, patches the auth store's
 * cached user in place (see auth.store.ts's updateName) so the new name
 * shows up everywhere it's read from — sidebar, header, POS "Clocked In"
 * — without a page reload or a fresh login. Deliberately does not touch
 * api-client.ts's shared auth-refresh singleton; the access token/JWT
 * itself doesn't carry first/last name, so nothing about the session
 * needs to change here.
 */
export function useUpdateProfile() {
  const updateName = useAuthStore((state) => state.updateName);

  return useMutation({
    mutationFn: async (name: string) => {
      const response = await apiClient<UpdateProfileResponse>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to update name'));
      return response.data;
    },
    onSuccess: (data) => {
      updateName(data.user.first_name, data.user.last_name);
    },
  });
}
