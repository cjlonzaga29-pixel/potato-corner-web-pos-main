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

const REFRESH_RETRY_DELAY_MS = 300;

interface RestoreAttempt {
  accessToken: string | null;
  /**
   * Mirrors middleware.ts's resolveAccessToken (ae41a66): true when the
   * refresh call failed for a reason other than the token actually being
   * invalid/missing (network throw, or any error response other than
   * REFRESH_MISSING/REFRESH_INVALID) — must not be treated as a dead
   * session.
   */
  transientError: boolean;
}

async function attemptRefresh(): Promise<RestoreAttempt> {
  try {
    const response = await apiClient<RefreshResponseData>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ device_id: getOrCreateDeviceId() }),
    });

    if (response.data?.access_token) {
      return { accessToken: response.data.access_token, transientError: false };
    }

    const errorCode = typeof response.error === 'object' ? response.error?.code : undefined;
    const isInvalid = errorCode === 'REFRESH_INVALID' || errorCode === 'REFRESH_MISSING';
    return { accessToken: null, transientError: !isInvalid };
  } catch {
    return { accessToken: null, transientError: true };
  }
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
      try {
        let attempt = await attemptRefresh();
        if (cancelled) return;

        // A single retry absorbs short transient failures before falling
        // back to treating it as transient — same shape as middleware.ts's
        // REFRESH_RETRY_DELAY_MS retry, so both layers agree on how long a
        // hiccup gets before it's accepted as real.
        if (attempt.transientError) {
          await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
          if (cancelled) return;
          attempt = await attemptRefresh();
          if (cancelled) return;
        }

        if (attempt.accessToken) {
          // The refresh endpoint only returns a new access token, not the
          // full user profile — decode the token for id/role/email/branch_ids
          // (first/last name aren't part of the locked JWT payload, so they
          // stay blank until the next full login; a dedicated profile
          // endpoint would be needed to restore them here).
          const payload = decodeJwtPayload(attempt.accessToken);
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
              attempt.accessToken,
            );
            return;
          }
        }

        // Only a genuinely dead session (invalid/missing refresh token)
        // forces a logout + redirect. A transient failure falls through
        // here without clearing auth or navigating — the store is left as
        // the pre-existing unauthenticated state on a hard reload, and the
        // next navigation gets a fresh chance, mirroring middleware.ts's
        // fail-open behavior instead of bouncing on a hiccup.
        if (!attempt.transientError) {
          clearAuth();
          router.replace('/login');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // Skip the silent refresh if the store already holds a valid
    // access token (e.g. this mount is a client-side navigation between
    // authenticated pages, not a hard reload). Calling restoreSession()
    // here would race the middleware's own server-side refresh-token
    // rotation on the very next navigation — refresh tokens are single-use,
    // so whichever request reaches the backend second gets REFRESH_INVALID
    // and bounces the user to /login. Only run on a genuine hard reload,
    // where the in-memory store is empty and this is the only way back in.
    if (useAuthStore.getState().accessToken) {
      return;
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
