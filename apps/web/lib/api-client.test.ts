import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      accessToken: 'stale-token',
      user: { id: 'u1' },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
    })),
  },
}));

vi.mock('./device', () => ({
  getOrCreateDeviceId: () => 'device-1',
}));

vi.mock('./constants', () => ({
  API_URL: 'https://api.test',
}));

import { apiClient } from './api-client';
import { useAuthStore } from '@/stores/auth.store';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function htmlResponse(status: number, html: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    json: async () => {
      throw new SyntaxError(`Unexpected token '<', "${html.slice(0, 9)}"... is not valid JSON`);
    },
    text: async () => html,
  } as unknown as Response;
}

describe('apiClient refresh race', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('dedupes concurrent 401s into a single refresh call', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
      }
      return Promise.resolve(jsonResponse(200, { data: { ok: true }, error: null, meta: null }));
    });
    // First call returns 401 once per path, then 200 on retry.
    let calls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
      }
      calls += 1;
      return Promise.resolve(jsonResponse(calls <= 3 ? 401 : 200, { data: null, error: 'TOKEN_MISSING', meta: null }));
    });

    await Promise.all([
      apiClient('/api/products'),
      apiClient('/api/products'),
      apiClient('/api/products'),
    ]);

    const refreshCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/auth/refresh'));
    expect(refreshCalls.length).toBe(1);
  });

  it('queues a fresh request behind an in-flight refresh instead of starting its own', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let refreshResolve!: (v: Response) => void;
    const refreshPromise = new Promise<Response>((resolve) => {
      refreshResolve = resolve;
    });

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) return refreshPromise;
      return Promise.resolve(jsonResponse(200, { data: { ok: true }, error: null, meta: null }));
    });

    // Kick off a request that 401s and starts a refresh.
    fetchMock.mockImplementationOnce((_url: string) => Promise.resolve(jsonResponse(401, { data: null, error: 'TOKEN_MISSING', meta: null })));
    const first = apiClient('/api/products');

    // Give the 401 handler a tick to call refreshAccessToken() and set refreshInFlight.
    await new Promise((r) => setTimeout(r, 0));

    // A second, unrelated request starts while refresh is in flight.
    const second = apiClient('/api/products/123');
    await new Promise((r) => setTimeout(r, 0));

    // The second request must not have hit the network yet — it's waiting on refreshInFlight.
    const productCallsBeforeResolve = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/products/123'));
    expect(productCallsBeforeResolve.length).toBe(0);

    refreshResolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
    await Promise.all([first, second]);

    const refreshCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/auth/refresh'));
    expect(refreshCalls.length).toBe(1);
  });

  it('does not retry a second time when the retried request also 401s', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
      }
      return Promise.resolve(jsonResponse(401, { data: null, error: 'TOKEN_MISSING', meta: null }));
    });

    await apiClient('/api/products');

    const refreshCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/auth/refresh'));
    const productCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/products'));
    expect(refreshCalls.length).toBe(1);
    expect(productCalls.length).toBe(2); // original + exactly one retry, no loop
  });

  it('clears auth and does not throw when refresh itself fails', async () => {
    const clearAuth = vi.fn();
    (useAuthStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      accessToken: 'stale-token',
      user: { id: 'u1' },
      setAuth: vi.fn(),
      clearAuth,
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        return Promise.resolve(jsonResponse(500, { data: null, error: 'INTERNAL', meta: null }));
      }
      return Promise.resolve(jsonResponse(401, { data: null, error: 'TOKEN_MISSING', meta: null }));
    });

    await apiClient('/api/products');

    expect(clearAuth).toHaveBeenCalled();
  });

  it('MANDATORY: 10 simultaneous 401s collapse into exactly 1 refresh call, each original request retrying at most once', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const productCallCounts = new Map<string, number>();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
      }
      const seen = (productCallCounts.get(url) ?? 0) + 1;
      productCallCounts.set(url, seen);
      // Every path 401s on its first hit, then succeeds on retry.
      return Promise.resolve(jsonResponse(seen === 1 ? 401 : 200, { data: { ok: true }, error: null, meta: null }));
    });

    const paths = Array.from({ length: 10 }, (_, i) => `/api/resource-${i}`);
    const results = await Promise.all(paths.map((p) => apiClient(p)));

    const refreshCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/auth/refresh'));
    expect(refreshCalls.length).toBe(1);

    for (const [url, count] of productCallCounts) {
      expect(count, `${url} should be called original + exactly one retry`).toBe(2);
    }
    for (const result of results) {
      expect(result.data).toEqual({ ok: true });
    }
  });

  it('a direct POST /api/auth/refresh call (use-auth.ts mount-time restore) shares the same in-flight refresh as a concurrent 401-triggered one, and the woken request uses the fresh token itself rather than racing the store update', async () => {
    // A stateful store stand-in: setAuth actually updates what getState()
    // returns next, since the test needs to prove the gated request reads a
    // genuinely fresh token — not just that some setAuth() was called.
    let currentToken = 'stale-token';
    const setAuth = vi.fn((_user: unknown, token: string) => {
      currentToken = token;
    });
    (useAuthStore.getState as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      accessToken: currentToken,
      user: { id: 'u1' },
      setAuth,
      clearAuth: vi.fn(),
    }));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let refreshResolve!: (v: Response) => void;
    const refreshPromise = new Promise<Response>((resolve) => {
      refreshResolve = resolve;
    });
    let refreshFetchCount = 0;

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/auth/refresh')) {
        refreshFetchCount += 1;
        return refreshPromise;
      }
      const authHeader = (init?.headers as Headers)?.get('Authorization');
      if (authHeader === 'Bearer new-token') {
        return Promise.resolve(jsonResponse(200, { data: { ok: true }, error: null, meta: null }));
      }
      return Promise.resolve(jsonResponse(401, { data: null, error: 'TOKEN_MISSING', meta: null }));
    });

    // Simulates use-auth.ts's attemptRefresh(): a direct call to apiClient('/api/auth/refresh', ...).
    const mountTimeRestore = apiClient('/api/auth/refresh', { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 0));

    // A data request 401s while that mount-time refresh is still in flight.
    const dataRequest = apiClient('/api/products');
    await new Promise((r) => setTimeout(r, 0));

    expect(refreshFetchCount).toBe(1);

    refreshResolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
    const [, dataResult] = await Promise.all([mountTimeRestore, dataRequest]);

    // Exactly one refresh call total, and the gated request succeeded on its
    // first real attempt with the fresh token instead of 401ing again and
    // starting a second refresh cycle.
    expect(refreshFetchCount).toBe(1);
    expect(dataResult.data).toEqual({ ok: true });
  });

  it('starts a fresh (non-deduped) refresh cycle for a later, non-concurrent 401 once the prior refresh cycle has fully settled', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let refreshCycle = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        refreshCycle += 1;
        return Promise.resolve(
          jsonResponse(200, { data: { access_token: `token-${refreshCycle}` }, error: null, meta: null }),
        );
      }
      // Every product call 401s once (simulating the token going stale
      // again by the time of the second, later apiClient call) then
      // succeeds on its single retry.
      return Promise.resolve(jsonResponse(401, { data: { ok: true }, error: null, meta: null }));
    });

    // Two fully sequential (non-overlapping) apiClient calls — the second
    // only starts after the first has completely settled — must each
    // independently trigger and complete their own refresh cycle. The
    // shared singleton (auth-refresh.ts) must reset after each cycle so it
    // never gets stuck "always in flight" after the first refresh.
    await apiClient('/api/products');
    await apiClient('/api/products');

    const refreshCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/auth/refresh'));
    expect(refreshCalls.length).toBe(2);
  });

  it('surfaces a plain-language session-expired message, never the raw backend token code, once refresh fails', async () => {
    (useAuthStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      accessToken: 'stale-token',
      user: { id: 'u1' },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/auth/refresh')) {
        return Promise.resolve(jsonResponse(401, { data: null, error: { code: 'REFRESH_INVALID' }, meta: null }));
      }
      // Mirrors authenticate.ts's unauthorized() — a bare code, no `message`.
      return Promise.resolve(jsonResponse(401, { data: null, error: { code: 'TOKEN_EXPIRED' }, meta: null }));
    });

    const result = await apiClient('/api/transactions', { method: 'POST', body: '{}' });

    expect(result.error).toEqual({ code: 'SESSION_EXPIRED', message: 'Session expired. Please sign in again.' });
  });
});

describe('apiClient accessTokenOverride refresh (Task 209.56C — POS Terminal Employee-scoped token)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('retries once with a fresh override token when the current one 401s, and succeeds silently', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const seenAuthHeaders: (string | null)[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const headers = init.headers as Headers;
      seenAuthHeaders.push(headers.get('Authorization'));
      if (headers.get('Authorization') === 'Bearer stale-employee-token') {
        return Promise.resolve(jsonResponse(401, { data: null, error: { code: 'TOKEN_EXPIRED' }, meta: null }));
      }
      return Promise.resolve(jsonResponse(200, { data: { id: 'txn-1' }, error: null, meta: null }));
    });

    const refreshOverrideToken = vi.fn().mockResolvedValue('fresh-employee-token');
    const result = await apiClient(
      '/api/transactions',
      { method: 'POST', body: '{}' },
      'stale-employee-token',
      refreshOverrideToken,
    );

    expect(refreshOverrideToken).toHaveBeenCalledTimes(1);
    expect(seenAuthHeaders).toEqual(['Bearer stale-employee-token', 'Bearer fresh-employee-token']);
    expect(result.data).toEqual({ id: 'txn-1' });
    expect(result.error).toBeNull();
  });

  it('never surfaces the raw backend token code when refreshing the override token itself fails', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse(401, { data: null, error: { code: 'TOKEN_EXPIRED' }, meta: null }));

    const refreshOverrideToken = vi.fn().mockResolvedValue(null);
    const result = await apiClient('/api/transactions', { method: 'POST', body: '{}' }, 'stale-employee-token', refreshOverrideToken);

    expect(refreshOverrideToken).toHaveBeenCalledTimes(1);
    expect(result.error).toEqual({ code: 'EMPLOYEE_SESSION_EXPIRED', message: 'Employee session expired. Please select the employee again.' });
  });

  it('retries the override-token request only once, even if the refreshed token also 401s (no loop)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse(401, { data: null, error: { code: 'TOKEN_EXPIRED' }, meta: null }));

    const refreshOverrideToken = vi.fn().mockResolvedValue('still-dead-token');
    await apiClient('/api/transactions', { method: 'POST', body: '{}' }, 'stale-employee-token', refreshOverrideToken);

    expect(refreshOverrideToken).toHaveBeenCalledTimes(1);
    const txnCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/transactions'));
    expect(txnCalls.length).toBe(2); // original + exactly one retry
  });

  it('never touches the global session refresh path for an override-token 401', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse(401, { data: null, error: { code: 'TOKEN_EXPIRED' }, meta: null }));

    const refreshOverrideToken = vi.fn().mockResolvedValue(null);
    await apiClient('/api/transactions', { method: 'POST', body: '{}' }, 'stale-employee-token', refreshOverrideToken);

    const globalRefreshCalls = fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/api/auth/refresh'));
    expect(globalRefreshCalls.length).toBe(0);
  });
});

describe('apiClient MUST_CHANGE_PASSWORD redirect (Task 209.x — stale-session guard)', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    sessionStorage.clear();
    // jsdom throws "Not implemented: navigation" on a real assignment to
    // window.location.href — stub out a plain writable object instead so
    // the redirect itself can be asserted on without that noise.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, pathname: '/admin/dashboard', search: '', href: 'https://app.test/admin/dashboard' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('redirects to /change-password on a 403 MUST_CHANGE_PASSWORD that belongs to the current session', async () => {
    (useAuthStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      accessToken: 'current-token',
      user: { id: 'u1' },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse(403, { data: null, error: { code: 'MUST_CHANGE_PASSWORD' }, meta: null }));

    await apiClient('/api/employees');

    expect(window.location.href).toBe('/change-password');
    expect(sessionStorage.getItem('pc_redirect_after_password_change')).toBe('/admin/dashboard');
  });

  it('does NOT redirect when the 403 belongs to a session the store has since moved on from (e.g. a fresh login already landed)', async () => {
    // The request was sent under 'old-token', but by the time its (delayed)
    // response comes back, the store already holds a different token — a
    // fresh login/refresh happened while this request was still in flight.
    // Task 180's changePassword revokes the old session's tokens, so this
    // exact case is a stale response from a session that no longer exists
    // and must not hijack the page the user is now legitimately on.
    (useAuthStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      accessToken: 'old-token',
      user: { id: 'u1' },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => {
      // Simulate the store moving on to a fresh session while this request
      // was in flight (a new login completed before this slow response landed).
      (useAuthStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
        accessToken: 'fresh-token-from-new-login',
        user: { id: 'u1' },
        setAuth: vi.fn(),
        clearAuth: vi.fn(),
      });
      return jsonResponse(403, { data: null, error: { code: 'MUST_CHANGE_PASSWORD' }, meta: null });
    });

    await apiClient('/api/employees');

    expect(window.location.href).toBe('https://app.test/admin/dashboard');
    expect(sessionStorage.getItem('pc_redirect_after_password_change')).toBeNull();
  });

  it('does not redirect again when already on /change-password', async () => {
    window.location.pathname = '/change-password';
    (useAuthStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      accessToken: 'current-token',
      user: { id: 'u1' },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse(403, { data: null, error: { code: 'MUST_CHANGE_PASSWORD' }, meta: null }));

    await apiClient('/api/employees');

    expect(window.location.href).toBe('https://app.test/admin/dashboard');
  });
});

describe('apiClient safe response parsing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns a cashier-safe structured error instead of throwing when the server returns HTML', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(htmlResponse(502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>'));

    const result = await apiClient('/api/transactions', { method: 'POST', body: '{}' });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(
      expect.objectContaining({ code: 'UNREADABLE_RESPONSE', message: expect.stringContaining('check Receipts') }),
    );
  });

  it('never lets a SyntaxError from response.json() escape apiClient', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(htmlResponse(200, '<!DOCTYPE html>'));

    await expect(apiClient('/api/transactions')).resolves.not.toThrow();
  });

  it('returns a structured network error when fetch itself rejects (offline/DNS/connection reset)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await apiClient('/api/transactions', { method: 'POST', body: '{}' });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({ code: 'NETWORK_ERROR' }));
  });

  it('still parses a normal JSON success response correctly', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'txn-1' }, error: null, meta: null }));

    const result = await apiClient<{ id: string }>('/api/transactions');

    expect(result.data).toEqual({ id: 'txn-1' });
    expect(result.error).toBeNull();
  });

  it('treats a 204 No Content response as a clean success without reading the body', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: async () => {
        throw new Error('should not be called for 204');
      },
    } as unknown as Response);

    const result = await apiClient('/api/transactions/txn-1', { method: 'DELETE' });

    expect(result).toEqual({ data: null, error: null, meta: null });
  });
});
