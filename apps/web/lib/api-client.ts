import { useAuthStore } from '@/stores/auth.store';
import { broadcastLogout } from './auth-broadcast';
import { getOrCreateDeviceId } from './device';
import { decodeJwtPayload } from './jwt';
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
        if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
        const body = (await response.json().catch(() => null)) as ApiResponse<RefreshResponseData> | null;
        return body?.data?.access_token ?? null;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/**
 * A response body is only safe to hand to response.json() when the server
 * actually says it sent JSON. Without this check, any non-JSON response on
 * the way to the browser — a Cloudflare/Render gateway error page, a stale
 * proxy hop, a crashed origin's default HTML error document — surfaces to
 * the caller as an uncaught "Unexpected token '<', <!DOCTYPE... is not
 * valid JSON" SyntaxError, even when the mutation it was reporting on
 * (e.g. a POS checkout) already committed successfully server-side.
 */
function isJsonResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('application/json');
}

const UNREADABLE_RESPONSE_ERROR = {
  code: 'UNREADABLE_RESPONSE',
  message: 'Checkout could not be confirmed. Please check Receipts before trying again.',
} as const;

/**
 * Task 209.3 — authenticate.ts's `unauthorized()` (apps/api/src/middleware/
 * authenticate.ts) responds with `{ error: { code } }` and no `message`
 * field for TOKEN_EXPIRED/TOKEN_MISSING/TOKEN_INVALID/TOKEN_REVOKED. Every
 * caller's error surface (errorMessage() in use-transactions.ts and
 * elsewhere) falls back to `error.code` when `error.message` is absent, so
 * without this a confirmed-dead session (refresh already failed, logout
 * already broadcast below) would show the raw backend code — e.g. literally
 * the string "TOKEN_EXPIRED" — as the cashier-facing Charge error, instead
 * of a plain-language message. This is the one card-safe, stable message
 * used everywhere a request fails because the session could not be
 * refreshed, regardless of which specific token error triggered it.
 */
const SESSION_EXPIRED_ERROR = {
  code: 'SESSION_EXPIRED',
  message: 'Session expired. Please sign in again.',
} as const;

/**
 * Task 209.56C — the Employee-scoped access token minted by
 * /api/auth/select-employee (see terminal/page.tsx's activeEmployeeToken)
 * has no refresh token of its own and a 15-minute TTL (config.jwt.accessTokenTtl),
 * so any shift running longer than that hit this same TOKEN_EXPIRED-with-no-
 * message gap SESSION_EXPIRED_ERROR above was introduced for on the global
 * session — except this path is scoped to just the Employee selection, not
 * the whole Branch Account session, so it gets its own distinct code/message
 * (the caller, terminal/page.tsx's refreshEmployeeToken, drops back to "Who's
 * working?" rather than logging the Branch Account out).
 */
const EMPLOYEE_SESSION_EXPIRED_ERROR = {
  code: 'EMPLOYEE_SESSION_EXPIRED',
  message: 'Employee session expired. Please select the employee again.',
} as const;

function buildHeaders(init?: RequestInit, accessTokenOverride?: string): Headers {
  const headers = new Headers(init?.headers);
  // FormData (multipart uploads, e.g. payment proof photos) must not get a
  // manual Content-Type — the browser sets one with the correct multipart boundary.
  if (!(init?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const accessToken = accessTokenOverride ?? useAuthStore.getState().accessToken;
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
 *
 * Returns the raw `Response` — callers that need the parsed `ApiResponse<T>`
 * envelope should go through `apiClient()` below, which wraps this. Binary/
 * non-JSON endpoints (e.g. report file downloads) can call this directly to
 * get the same auth/refresh/retry behavior without `apiClient`'s `.json()`
 * parsing.
 */
export async function fetchAuthenticated(
  path: string,
  init?: RequestInit,
  _isRetry = false,
  accessTokenOverride?: string,
  /**
   * Task 209.56C — mints a fresh Employee-scoped token (re-calling
   * /api/auth/select-employee) when the current accessTokenOverride 401s.
   * Only ever invoked on the accessTokenOverride path below; the global
   * session's own refresh (refreshAccessToken above) is untouched by this.
   */
  refreshOverrideToken?: () => Promise<string | null>,
): Promise<Response> {
  const isAuthPath = path === '/api/auth/refresh' || path === '/api/auth/login';
  // A caller-supplied token (e.g. the POS Terminal's active-employee token —
  // see terminal/page.tsx) belongs to a session the global auth store never
  // holds. It has its own lifecycle: no dedup against refreshInFlight, and a
  // 401 on it must never trigger this module's global-store refresh/clear —
  // that would touch the Branch account's own session over an employee
  // token expiring, which selecting an employee must never do.
  if (accessTokenOverride) {
    const response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers: buildHeaders(init, accessTokenOverride) });
    if (response.status === 401 && !_isRetry && refreshOverrideToken) {
      const newToken = await refreshOverrideToken();
      if (newToken) {
        return fetchAuthenticated(path, init, true, newToken, refreshOverrideToken);
      }
      // Employee token is dead and re-selecting the Employee itself failed
      // (e.g. deactivated mid-shift) — same reasoning as SESSION_EXPIRED_ERROR
      // below: the original response body only ever carries a bare backend
      // code with no `message`, so synthesize a cashier-safe one instead of
      // ever surfacing raw TOKEN_EXPIRED here.
      return new Response(JSON.stringify({ data: null, error: EMPLOYEE_SESSION_EXPIRED_ERROR, meta: null }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  }
  if (refreshInFlight && !_isRetry && !isAuthPath) {
    // A refresh is already resolving elsewhere (e.g. another mutation's 401
    // triggered it). Wait for it instead of firing with a token we know is
    // stale — otherwise this request 401s on its own timeline, finds
    // refreshInFlight already cleared, and starts a redundant refresh of
    // its own (the storm seen in the 2026-07-20 audit).
    console.warn('[apiClient] awaiting in-flight refresh before request', path);
    await refreshInFlight;
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: buildHeaders(init),
    });
  } catch (err) {
    console.error('[apiClient] network error', { path, method: init?.method ?? 'GET', err });
    throw err;
  }

  if (response.status === 401 && !_isRetry && path !== '/api/auth/refresh' && path !== '/api/auth/login') {
    console.warn('[apiClient] 401, triggering refresh', path);
    const newToken = await refreshAccessToken();
    if (newToken) {
      const previousUser = useAuthStore.getState().user;
      if (previousUser) {
        // Rebuild from the new token's own claims rather than reusing the
        // stale cached user object — a role change server-side (e.g. a
        // promotion to super_admin) must take effect the moment the refreshed
        // token carries it, not stay pinned to whatever role was cached at
        // login. First/last name aren't in the JWT, so they're carried over
        // from the prior cached user (login-only fields). This is best-effort:
        // if the token doesn't decode, fall back to the previous user as-is
        // rather than treating a successful refresh as a failure — the retry
        // below must still happen either way.
        const payload = decodeJwtPayload(newToken);
        const updatedUser = payload
          ? {
              id: payload.user_id,
              role: payload.role,
              email: payload.email,
              firstName: previousUser.firstName,
              lastName: previousUser.lastName,
              branchIds: 'branch_ids' in payload ? payload.branch_ids : [],
            }
          : previousUser;
        useAuthStore.getState().setAuth(updatedUser, newToken);
        return fetchAuthenticated(path, init, true);
      }
    }

    useAuthStore.getState().clearAuth();
    // A hard `window.location.href` reload here throws away the whole SPA
    // (and any in-flight work on the page) just to reach /login. Broadcasting
    // instead reuses the cross-tab logout channel — this tab's own
    // subscribeToLogout listener (registered by useAuth) picks it up and does
    // a normal router.replace('/login'), so a background query's dead
    // session doesn't feel like a random full-page reload.
    if (typeof window !== 'undefined') {
      broadcastLogout();
    }

    // The session is now confirmed dead (refresh failed) and logout has
    // already been broadcast — return a synthetic response carrying the
    // cashier-safe SESSION_EXPIRED_ERROR instead of the original response,
    // whose body only ever carries a bare backend code with no `message`
    // (see SESSION_EXPIRED_ERROR's comment above). Callers that already
    // navigated away via subscribeToLogout never see this render, but any
    // caller still awaiting this promise (e.g. the Charge mutation's own
    // catch block) gets the plain-language message instead of a raw code.
    return new Response(JSON.stringify({ data: null, error: SESSION_EXPIRED_ERROR, meta: null }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  return response;
}

/**
 * JSON-parsing wrapper around `fetchAuthenticated` — every existing caller
 * in the app goes through this. Handles the 204-no-body case, the non-JSON-
 * response guard, JSON parse failures, and the MUST_CHANGE_PASSWORD redirect.
 */
export async function apiClient<T>(
  path: string,
  init?: RequestInit,
  accessTokenOverride?: string,
  refreshOverrideToken?: () => Promise<string | null>,
): Promise<ApiResponse<T>> {
  let response: Response;
  try {
    response = await fetchAuthenticated(path, init, false, accessTokenOverride, refreshOverrideToken);
  } catch {
    return {
      data: null,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Could not reach the server. Please check your connection before trying again.',
      },
      meta: null,
    };
  }

  // 204 No Content (e.g. DELETE endpoints) has no body — calling .json() on
  // it throws "Unexpected end of JSON input".
  if (response.status === 204) {
    return { data: null, error: null, meta: null };
  }

  if (!isJsonResponse(response)) {
    const preview = await response.text().then((t) => t.slice(0, 300)).catch(() => '');
    console.error('[apiClient] non-JSON response', {
      path,
      method: init?.method ?? 'GET',
      status: response.status,
      contentType: response.headers.get('content-type'),
      requestId: response.headers.get('x-request-id'),
      preview,
    });
    return { data: null, error: UNREADABLE_RESPONSE_ERROR, meta: null };
  }

  let body: ApiResponse<T>;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch (err) {
    console.error('[apiClient] JSON parse failure', { path, method: init?.method ?? 'GET', status: response.status, err });
    return { data: null, error: UNREADABLE_RESPONSE_ERROR, meta: null };
  }

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
