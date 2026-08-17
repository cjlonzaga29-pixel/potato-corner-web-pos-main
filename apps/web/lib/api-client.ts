import { useAuthStore } from '@/stores/auth.store';
import { broadcastLogout } from './auth-broadcast';
import { getOrCreateDeviceId } from './device';
import { decodeJwtPayload } from './jwt';
import { API_URL } from './constants';
import { getOrStartRefresh, peekInFlightRefresh } from './auth-refresh';

interface ApiResponse<T> {
  data: T | null;
  error: { code: string; message?: string; details?: unknown } | string | null;
  meta: unknown;
}

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
 * Resolves the shared in-flight refresh (see auth-refresh.ts) down to just
 * the access token, collapsing every non-success outcome to null — this
 * matches the pre-existing contract callers here relied on.
 */
async function refreshAccessToken(): Promise<string | null> {
  const outcome = await getOrStartRefresh();
  return outcome.kind === 'json' ? outcome.body?.data?.access_token ?? null : null;
}

/**
 * Reconstructs a `Response` from the shared refresh singleton's outcome so a
 * direct `POST /api/auth/refresh` call (e.g. use-auth.ts's mount-time
 * restore, via apiClient) still gets a real Response to parse — identical in
 * shape to what a raw `fetch` would have produced — while still funneling
 * through the same dedup as the 401-retry path below.
 */
async function refreshViaSharedSingleton(): Promise<Response> {
  const outcome = await getOrStartRefresh();
  if (outcome.kind === 'network-error') {
    throw new Error('Failed to reach the refresh endpoint');
  }
  if (outcome.kind === 'non-json') {
    return new Response('', { status: outcome.status, headers: { 'content-type': 'text/plain' } });
  }
  return new Response(JSON.stringify(outcome.body ?? { data: null, error: null, meta: null }), {
    status: outcome.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Writes a freshly-refreshed access token into the auth store, rebuilding
 * the cached user from the new token's own claims (a role change server-side
 * must take effect the moment the refreshed token carries it). Shared by
 * both the 401-retry path and the gate-wait path below — a request that
 * queued behind someone else's in-flight refresh must apply the token itself
 * rather than assuming whichever caller triggered that refresh has already
 * written it to the store by the time this request wakes up (that's a
 * separate, not-necessarily-faster promise chain — see use-auth.ts's
 * restoreSession, which does its own decode+setAuth after apiClient resolves).
 *
 * Deliberately does NOT require a pre-existing cached user. A page landed on
 * directly (hard navigation/reload — e.g. /change-password, reached with a
 * still-valid HttpOnly refresh cookie but an empty in-memory Zustand store)
 * has no previousUser to rebuild onto, but the refresh itself is still
 * genuinely valid: the store used to bail out here with `false` in that case,
 * which the 401-retry path below then treated identically to a truly dead
 * session — clearing auth and surfacing SESSION_EXPIRED even though a brand
 * new access token had just been successfully issued. firstName/lastName
 * fall back to '' when there's nothing to preserve, same as use-auth.ts's
 * restoreSession does for the equivalent mount-time-refresh case.
 */
function applyRefreshedToken(newToken: string): boolean {
  const previousUser = useAuthStore.getState().user;
  const payload = decodeJwtPayload(newToken);
  // Nothing to build a user from either way — genuinely can't apply this token.
  if (!payload && !previousUser) return false;
  const updatedUser = payload
    ? {
        id: payload.user_id,
        role: payload.role,
        email: payload.email,
        firstName: previousUser?.firstName ?? '',
        lastName: previousUser?.lastName ?? '',
        branchIds: 'branch_ids' in payload ? payload.branch_ids : [],
      }
    : // The guard above proves previousUser is non-null whenever payload isn't.
      (previousUser as NonNullable<typeof previousUser>);
  useAuthStore.getState().setAuth(updatedUser, newToken);
  return true;
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

  // A direct call to /api/auth/refresh (use-auth.ts's mount-time restore
  // goes through here via apiClient) is routed through the same shared
  // singleton as the 401-retry path below, instead of firing its own raw
  // fetch — this is what actually collapses concurrent callers across
  // different modules onto exactly one network request.
  if (path === '/api/auth/refresh') {
    return refreshViaSharedSingleton();
  }

  const inFlightRefresh = peekInFlightRefresh();
  if (inFlightRefresh && !_isRetry && !isAuthPath) {
    // A refresh is already resolving elsewhere (e.g. another mutation's 401
    // triggered it, or a mount-time restore is running). Wait for it instead
    // of firing with a token we know is stale — otherwise this request 401s
    // on its own timeline and starts a redundant refresh of its own (the
    // storm seen in the 2026-07-20 audit, later found to still occur cross-
    // module — see auth-refresh.ts).
    console.warn('[apiClient] awaiting in-flight refresh before request', path);
    const outcome = await inFlightRefresh;
    // Apply the token here rather than assuming whichever caller triggered
    // this refresh has already written it to the store — that caller may
    // still have several of its own microtask hops left (e.g. use-auth.ts's
    // restoreSession decodes the JWT and calls setAuth only after its own
    // apiClient() call resolves), and this request must not race ahead of
    // that with a still-stale token.
    if (outcome.kind === 'json' && outcome.body?.data?.access_token) {
      applyRefreshedToken(outcome.body.data.access_token);
    }
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
    // applyRefreshedToken only fails when the new token doesn't decode —
    // it no longer requires a pre-existing cached user (see its own comment
    // above), so a genuinely successful refresh is never mistaken for a
    // dead session just because this page was hard-loaded with an empty store.
    if (newToken && applyRefreshedToken(newToken)) {
      return fetchAuthenticated(path, init, true);
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
  // Snapshot which session this specific call was made under. A request can
  // sit in flight for a while (slow/cold-starting backend — see
  // middleware.ts's REFRESH_FETCH_TIMEOUT_MS comment for a documented case
  // of this) and its response can land well after the user has since changed
  // their password and signed back in on a fresh session. Without this, a
  // late MUST_CHANGE_PASSWORD 403 that actually belongs to the old,
  // already-superseded session would still hard-redirect the browser away
  // from the new session's page — see the guard below.
  const requestAccessToken = accessTokenOverride ?? useAuthStore.getState().accessToken;
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
  //
  // Guarded on requestAccessToken still being the current session's token:
  // a password change revokes the token this request was sent under and
  // signs the user out, so a same-session retry can never legitimately race
  // this. If the store's access token has since moved on (a fresh login
  // happened while this request was still in flight), this 403 describes a
  // session that no longer exists and must not hijack the new one.
  if (
    response.status === 403 &&
    typeof body.error === 'object' &&
    body.error !== null &&
    body.error.code === 'MUST_CHANGE_PASSWORD' &&
    typeof window !== 'undefined' &&
    window.location.pathname !== '/change-password' &&
    requestAccessToken === useAuthStore.getState().accessToken
  ) {
    sessionStorage.setItem('pc_redirect_after_password_change', window.location.pathname + window.location.search);
    window.location.href = '/change-password';
  }

  return body;
}
