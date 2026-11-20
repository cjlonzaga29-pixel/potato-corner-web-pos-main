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

const CSRF_COOKIE_NAME = 'csrf-token';

function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
  const value = match?.[1];
  return value !== undefined ? decodeURIComponent(value) : null;
}

export type RefreshOutcome =
  | { kind: 'network-error' }
  | { kind: 'non-json'; status: number }
  | { kind: 'json'; status: number; body: ApiResponse<RefreshResponseData> | null };

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * POS-PERF-P62 — a refresh that hasn't answered by now is abandoned and
 * reported as unavailable (never as a sign-out). The API keeps the rotated
 * successor for this device for 30s (auth.repository.ts ROTATION_GRACE_MS),
 * about twice this, so the next attempt with the old cookie still succeeds.
 */
export const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Codes the API returns only when the session is really over: the refresh
 * token is missing, invalid, expired, revoked or replayed (401), or the
 * account may no longer sign in (403). Everything else — a network failure,
 * a timeout, 408, 429, any 5xx, a gateway's HTML page — says nothing about
 * the session and must not sign anyone out.
 */
const DEFINITIVE_REFRESH_REJECTIONS: Record<number, ReadonlySet<string>> = {
  401: new Set(['REFRESH_INVALID', 'REFRESH_MISSING']),
  403: new Set(['ACCOUNT_INACTIVE', 'BRANCH_INACTIVE', 'BRANCH_ASSIGNMENT_REMOVED']),
};

export type RefreshVerdict = { kind: 'ok'; accessToken: string } | { kind: 'rejected' } | { kind: 'unavailable' };

export function errorCodeOf(body: { error?: unknown } | null | undefined): string | undefined {
  const error = body?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

export function classifyRefreshOutcome(outcome: RefreshOutcome): RefreshVerdict {
  if (outcome.kind !== 'json') return { kind: 'unavailable' };
  const accessToken = outcome.body?.data?.access_token;
  if (outcome.status >= 200 && outcome.status < 300 && accessToken) return { kind: 'ok', accessToken };
  const code = errorCodeOf(outcome.body);
  if (code !== undefined && DEFINITIVE_REFRESH_REJECTIONS[outcome.status]?.has(code)) return { kind: 'rejected' };
  return { kind: 'unavailable' };
}

async function performRefresh(): Promise<RefreshOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
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
      signal: controller.signal,
    });

    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      return { kind: 'non-json', status: response.status };
    }
    const body = (await response.json().catch(() => null)) as ApiResponse<RefreshResponseData> | null;
    return { kind: 'json', status: response.status, body };
  } catch {
    return { kind: 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POS-PERF-P62 — tabs of one browser share one refresh cookie, so their
 * refreshes take turns under a Web Lock: the second tab sends the cookie the
 * first tab's answer just set, instead of the same old token at the same
 * moment. Where Web Locks are unavailable the API's per-session lock and
 * grace period still keep both tabs signed in.
 */
function coordinatedRefresh(): Promise<RefreshOutcome> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return performRefresh();
  return new Promise<RefreshOutcome>((resolve) => {
    // performRefresh never rejects, so the lock is released as soon as it answers.
    locks
      .request('pc-auth-refresh', async () => {
        resolve(await performRefresh());
      })
      .catch(async () => resolve(await performRefresh()));
  });
}

/**
 * Single source of truth for "is a token refresh in flight" across the whole
 * app — not just within one module. Before this existed, api-client.ts's
 * 401-retry path and use-auth.ts's mount-time restoreSession() each kept
 * their own separate in-flight singleton, so a request that 401'd while a
 * mount-time refresh was already running started a second, fully independent
 * POST /api/auth/refresh (live evidence: 2-3 concurrent calls per page load).
 * The refresh token is single-use and rotates on every call, so two
 * concurrent refreshes don't just waste a round trip — the loser gets
 * REFRESH_INVALID. Every caller now awaits this one shared promise instead.
 */
export function getOrStartRefresh(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = coordinatedRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function peekInFlightRefresh(): Promise<RefreshOutcome> | null {
  return refreshInFlight;
}
