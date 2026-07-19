import { useAuthStore } from '@/stores/auth.store';
import { getOrCreateDeviceId } from './device';
import { API_URL } from './constants';

interface ApiResponse<T> {
  data: T | null;
  error: { code: string; message?: string; details?: unknown } | string | null;
  meta: unknown;
}

interface RefreshResponseData {
  access_token: string;
}

let refreshInFlight: Promise<string | null> | null = null;

const CSRF_COOKIE_NAME = 'csrf-token';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Reads the non-HttpOnly csrf-token cookie the API's double-submit guard
 * (apps/api/src/middleware/csrf-guard.ts) issues on every response. Echoed
 * back as the X-CSRF-Token header on mutations so the API can confirm the
 * request came from JS running on this origin rather than a cross-site form.
 */
function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
  const value = match?.[1];
  return value !== undefined ? decodeURIComponent(value) : null;
}

/**
 * Calls POST /api/auth/refresh (the HttpOnly refresh cookie travels
 * automatically via credentials: 'include'). Deduplicated so concurrent
 * 401s from multiple in-flight requests only trigger one refresh call.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const csrfToken = getCsrfToken();
        const response = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify({ device_id: getOrCreateDeviceId() }),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as ApiResponse<RefreshResponseData>;
        return body.data?.access_token ?? null;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

function buildHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  // FormData (multipart uploads, e.g. product images) must not get a manual
  // Content-Type — the browser sets one with the correct multipart boundary.
  if (!(init?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const accessToken = useAuthStore.getState().accessToken;
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const deviceId = getOrCreateDeviceId();
  if (deviceId) headers.set('X-Device-ID', deviceId);

  const method = (init?.method ?? 'GET').toUpperCase();
  if (MUTATION_METHODS.has(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }

  return headers;
}

/**
 * fetch wrapper that transparently handles authentication: attaches the
 * bearer token and device ID, and on a 401 attempts a silent token refresh
 * before retrying the original request once. If refresh fails, clears the
 * auth store and redirects to /login — callers never see a 401 from an
 * expired (as opposed to genuinely invalid) session.
 */
export async function apiClient<T>(
  path: string,
  init?: RequestInit,
  _isRetry = false,
): Promise<ApiResponse<T>> {
  const isAuthPath = path === '/api/auth/refresh' || path === '/api/auth/login';
  if (refreshInFlight && !_isRetry && !isAuthPath) {
    // A refresh is already resolving elsewhere (e.g. another mutation's 401
    // triggered it). Wait for it instead of firing with a token we know is
    // stale — otherwise this request 401s on its own timeline, finds
    // refreshInFlight already cleared, and starts a redundant refresh of
    // its own (the storm seen in the 2026-07-20 audit).
    console.warn('[apiClient] awaiting in-flight refresh before request', path);
    await refreshInFlight;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: buildHeaders(init),
  });

  if (response.status === 401 && !_isRetry && path !== '/api/auth/refresh' && path !== '/api/auth/login') {
    console.warn('[apiClient] 401, triggering refresh', path);
    const newToken = await refreshAccessToken();
    if (newToken) {
      const user = useAuthStore.getState().user;
      if (user) useAuthStore.getState().setAuth(user, newToken);
      return apiClient<T>(path, init, true);
    }

    useAuthStore.getState().clearAuth();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  }

  // 204 No Content (e.g. DELETE endpoints) has no body — calling .json() on
  // it throws "Unexpected end of JSON input".
  if (response.status === 204) {
    return { data: null, error: null, meta: null };
  }

  const body = (await response.json()) as ApiResponse<T>;

  // Every non-exempt endpoint returns this when req.user.must_change_password
  // is true (see apps/api/src/middleware/require-password-change.ts). Stash
  // the page the user was on so /change-password can send them back after a
  // successful change, then hard-redirect — this must fully interrupt
  // whatever flow triggered it, not just resolve the promise.
  if (
    response.status === 403 &&
    typeof body.error === 'object' &&
    body.error !== null &&
    body.error.code === 'MUST_CHANGE_PASSWORD' &&
    typeof window !== 'undefined' &&
    window.location.pathname !== '/change-password'
  ) {
    sessionStorage.setItem('pc_redirect_after_password_change', window.location.pathname + window.location.search);
    window.location.href = '/change-password';
  }

  return body;
}
