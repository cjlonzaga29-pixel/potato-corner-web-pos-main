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

async function performRefresh(): Promise<RefreshOutcome> {
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

    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      return { kind: 'non-json', status: response.status };
    }
    const body = (await response.json().catch(() => null)) as ApiResponse<RefreshResponseData> | null;
    return { kind: 'json', status: response.status, body };
  } catch {
    return { kind: 'network-error' };
  }
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
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function peekInFlightRefresh(): Promise<RefreshOutcome> | null {
  return refreshInFlight;
}
