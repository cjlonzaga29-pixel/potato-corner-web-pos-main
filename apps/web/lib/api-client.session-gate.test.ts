import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./device', () => ({ getOrCreateDeviceId: () => 'device-1' }));
vi.mock('./constants', () => ({ API_URL: 'https://api.test' }));
vi.mock('./auth-broadcast', () => ({ broadcastLogout: vi.fn() }));

import { apiClient, isPublicApiPath } from './api-client';
import { broadcastLogout } from './auth-broadcast';
import { useAuthStore } from '@/stores/auth.store';

/** A JWT whose payload decode-jwt can read; the signature is irrelevant client-side. */
function token(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}
const SUPERVISOR_TOKEN = token({ user_id: 's1', role: 'supervisor', email: 's@x.test', branch_ids: ['b1'] });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type FetchCall = { path: string; auth: string | null };
let calls: FetchCall[];
let refreshAnswer: () => Promise<Response>;

beforeEach(() => {
  calls = [];
  // A new page load: memory-only token gone, nothing known yet.
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isLoading: true, sessionStatus: 'restoring' });
  refreshAnswer = async () => json(200, { data: { access_token: SUPERVISOR_TOKEN }, error: null, meta: null });
  vi.mocked(broadcastLogout).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, auth: new Headers(init?.headers).get('Authorization') });
      if (path === '/api/auth/refresh') return refreshAnswer();
      return json(200, { data: { ok: true }, error: null, meta: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const protectedCalls = () => calls.filter((c) => c.path !== '/api/auth/refresh');

describe('POS-PERF-P62 — protected requests wait for the session', () => {
  it('a query made before the restore starts is sent once, with the restored token, never without one', async () => {
    const results = await Promise.all([apiClient('/api/branches?status=active'), apiClient('/api/notifications'), apiClient('/api/branches/stats')]);

    expect(results.every((r) => r.error === null)).toBe(true);
    expect(calls.filter((c) => c.path === '/api/auth/refresh')).toHaveLength(1);
    expect(protectedCalls()).toHaveLength(3);
    expect(protectedCalls().every((c) => c.auth === `Bearer ${SUPERVISOR_TOKEN}`)).toBe(true);
    expect(useAuthStore.getState().sessionStatus).toBe('authenticated');
    expect(useAuthStore.getState().user?.branchIds).toEqual(['b1']);
  });

  it('a transient refresh failure sends nothing protected and does not invent a session', async () => {
    refreshAnswer = async () => json(503, { data: null, error: { code: 'SERVICE_UNAVAILABLE' }, meta: null });

    const result = await apiClient('/api/branches');

    expect(result.error).toMatchObject({ code: 'SESSION_UNCONFIRMED' });
    expect(protectedCalls()).toHaveLength(0);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(broadcastLogout).not.toHaveBeenCalled();
  });

  it('recovers on the next request once the server answers again (no stuck state)', async () => {
    refreshAnswer = async () => {
      throw new TypeError('Failed to fetch');
    };
    useAuthStore.getState().markSessionUnconfirmed();
    expect((await apiClient('/api/branches')).error).toMatchObject({ code: 'SESSION_UNCONFIRMED' });

    refreshAnswer = async () => json(200, { data: { access_token: SUPERVISOR_TOKEN }, error: null, meta: null });
    const second = await apiClient('/api/branches');

    expect(second.error).toBeNull();
    expect(protectedCalls()).toEqual([{ path: '/api/branches', auth: `Bearer ${SUPERVISOR_TOKEN}` }]);
  });

  it('a session the server ended signs out once and sends nothing protected', async () => {
    refreshAnswer = async () => json(401, { data: null, error: { code: 'REFRESH_INVALID' }, meta: null });

    const result = await apiClient('/api/branches');

    expect(result.error).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(protectedCalls()).toHaveLength(0);
    expect(useAuthStore.getState().sessionStatus).toBe('unauthenticated');
    expect(broadcastLogout).toHaveBeenCalledTimes(1);
  });

  it('once signed out, protected requests are answered locally: no refresh, no request', async () => {
    useAuthStore.getState().clearAuth();

    const result = await apiClient('/api/notifications');

    expect(result.error).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(calls).toHaveLength(0);
  });

  it('public endpoints go straight out without waiting for a session', async () => {
    refreshAnswer = () => new Promise(() => {}); // a restore that never answers must not hold sign-in
    const result = await apiClient('/api/auth/login', { method: 'POST', body: '{}' });

    expect(result.error).toBeNull();
    expect(calls).toEqual([{ path: '/api/auth/login', auth: null }]);
  });

  it('a request that already holds a token is not delayed by the gate', async () => {
    useAuthStore.getState().setAuth({ id: 's1', role: 'supervisor', email: null, firstName: '', lastName: '', branchIds: ['b1'] }, 'live-token');

    await apiClient('/api/branches');

    expect(calls).toEqual([{ path: '/api/branches', auth: 'Bearer live-token' }]);
  });

  it('classifies the public paths exactly', () => {
    for (const p of ['/api/auth/login', '/api/auth/refresh', '/api/auth/request-reset', '/api/auth/reset-password', '/api/auth/2fa/verify-login', '/api/auth/2fa/verify-backup-code', '/api/auth/pin/login', '/api/receipts/PC-MAIN01-20261121-0001']) {
      expect(isPublicApiPath(p)).toBe(true);
    }
    for (const p of ['/api/auth/logout', '/api/auth/select-employee', '/api/auth/profile', '/api/branches?status=active', '/api/receipts']) {
      expect(isPublicApiPath(p)).toBe(false);
    }
  });
});
