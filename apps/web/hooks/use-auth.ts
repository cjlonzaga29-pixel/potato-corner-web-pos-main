'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { getOrCreateDeviceId } from '@/lib/device';
import { decodeJwtPayload } from '@/lib/jwt';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

interface LoginResponseData {
  access_token: string;
  user: {
    id: string;
    role: AuthUser['role'];
    email: string;
    first_name: string;
    last_name: string;
    branch_ids: string[];
  };
}

interface RefreshResponseData {
  access_token: string;
}

function toAuthUser(user: LoginResponseData['user']): AuthUser {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    branchIds: user.branch_ids,
  };
}

/**
 * Authentication state and actions — wraps the auth Zustand store.
 * Attempts a silent refresh on mount so a page reload doesn't force a full
 * re-login (the access token is memory-only and is lost on reload; the
 * HttpOnly refresh cookie is what actually persists the session).
 */
export function useAuth() {
  const {
    user,
    accessToken,
    isAuthenticated,
    isLoading,
    setAuth,
    clearAuth,
    setLoading,
    hasRole,
    hasBranchAccess,
    isAdmin,
    isSupervisor,
    isStaff,
  } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const response = await apiClient<RefreshResponseData>('/api/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ device_id: getOrCreateDeviceId() }),
      });

      if (cancelled) return;

      if (response.data?.access_token) {
        // The refresh endpoint only returns a new access token, not the
        // full user profile — decode the token for id/role/email/branch_ids
        // (first/last name aren't part of the locked JWT payload, so they
        // stay blank until the next full login; a dedicated profile
        // endpoint would be needed to restore them here).
        const payload = decodeJwtPayload(response.data.access_token);
        if (payload) {
          setAuth(
            {
              id: payload.user_id,
              role: payload.role,
              email: payload.email,
              firstName: '',
              lastName: '',
              branchIds: 'branch_ids' in payload ? payload.branch_ids : [],
            },
            response.data.access_token,
          );
          return;
        }
      }

      setLoading(false);
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(email: string, password: string) {
    const deviceId = getOrCreateDeviceId();
    const response = await apiClient<LoginResponseData>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, device_id: deviceId }),
    });

    if (!response.data) {
      throw new Error(typeof response.error === 'string' ? response.error : response.error?.message ?? 'Login failed');
    }

    setAuth(toAuthUser(response.data.user), response.data.access_token);
    return response.data.user;
  }

  async function logout() {
    await apiClient('/api/auth/logout', { method: 'POST' });
    clearAuth();
    router.push('/login');
  }

  async function logoutAll() {
    await apiClient('/api/auth/logout-all', { method: 'POST' });
    clearAuth();
    router.push('/login');
  }

  return {
    user,
    accessToken,
    isAuthenticated,
    isLoading,
    login,
    logout,
    logoutAll,
    hasRole,
    hasBranchAccess,
    isAdmin,
    isSupervisor,
    isStaff,
  };
}
