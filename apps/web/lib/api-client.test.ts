import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    json: async () => body,
  } as Response;
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

    const refreshCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/api/auth/refresh'));
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
    fetchMock.mockImplementationOnce((url: string) => Promise.resolve(jsonResponse(401, { data: null, error: 'TOKEN_MISSING', meta: null })));
    const first = apiClient('/api/products');

    // Give the 401 handler a tick to call refreshAccessToken() and set refreshInFlight.
    await new Promise((r) => setTimeout(r, 0));

    // A second, unrelated request starts while refresh is in flight.
    const second = apiClient('/api/products/123');
    await new Promise((r) => setTimeout(r, 0));

    // The second request must not have hit the network yet — it's waiting on refreshInFlight.
    const productCallsBeforeResolve = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/api/products/123'));
    expect(productCallsBeforeResolve.length).toBe(0);

    refreshResolve(jsonResponse(200, { data: { access_token: 'new-token' }, error: null, meta: null }));
    await Promise.all([first, second]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/api/auth/refresh'));
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

    const refreshCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/api/auth/refresh'));
    const productCalls = fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/api/products'));
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
});
