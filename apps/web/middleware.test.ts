import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { middleware, config } from './middleware';

/** Builds an unsigned JWT-shaped string — middleware only decodes (never verifies) this locally. */
function fakeAccessToken(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${base64url({ alg: 'none' })}.${base64url(payload)}.sig`;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRequest(url: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(new Request(url, { headers }));
}

function requireLocation(response: Response): URL {
  const location = response.headers.get('location');
  if (!location) throw new Error('expected a Location header on the redirect response');
  return new URL(location);
}

describe('middleware /login redirect preserves returnTo', () => {
  it('appends the original path+query as ?returnTo= when there is no refresh cookie at all', async () => {
    const request = makeRequest('https://app.potatocorner.test/admin/reports?tab=sales');
    const response = await middleware(request);

    const location = requireLocation(response);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/admin/reports?tab=sales');
  });

  it('appends returnTo when the refresh cookie is present but genuinely invalid (REFRESH_INVALID, 401)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: null, error: { code: 'REFRESH_INVALID' } }), { status: 401 }),
    );

    const request = makeRequest('https://app.potatocorner.test/supervisor/reports', 'refresh_token=dead-token');
    const response = await middleware(request);

    const location = requireLocation(response);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/supervisor/reports');
    expect(fetchMock).toHaveBeenCalledTimes(1); // a genuine 401 never retries
  });

  it('does not redirect (fails open, no returnTo needed) on a transient refresh failure', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), { status: 500 }));

    const request = makeRequest('https://app.potatocorner.test/supervisor/reports', 'refresh_token=some-token');
    const response = await middleware(request);

    expect(response.headers.get('location')).toBeNull();
  });

  it('bounds the refresh fetch with an abort signal and fails open when it times out, instead of hanging the invocation', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const request = makeRequest('https://app.potatocorner.test/supervisor/reports', 'refresh_token=some-token');
    const response = await middleware(request);

    expect(response.headers.get('location')).toBeNull(); // same fail-open path as any transient failure
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried once, per the existing transient-failure path
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe('middleware /change-password loop guard', () => {
  it('redirects a must-change-password account to /change-password from any other page', async () => {
    const token = fakeAccessToken({ role: 'branch', must_change_password: true, exp: Math.floor(Date.now() / 1000) + 900 });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { access_token: token }, error: null, meta: null }), { status: 200 }),
    );

    const request = makeRequest('https://app.potatocorner.test/branch/dashboard', 'refresh_token=good-token');
    const response = await middleware(request);

    expect(requireLocation(response).pathname).toBe('/change-password');
  });

  it('sends a cleared (must_change_password=false) account away from /change-password to its own dashboard, instead of re-showing the form', async () => {
    const token = fakeAccessToken({ role: 'branch', must_change_password: false, exp: Math.floor(Date.now() / 1000) + 900 });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { access_token: token }, error: null, meta: null }), { status: 200 }),
    );

    const request = makeRequest('https://app.potatocorner.test/change-password', 'refresh_token=good-token');
    const response = await middleware(request);

    expect(requireLocation(response).pathname).toBe('/branch/dashboard');
  });
});

describe('POS-PERF-P26 — Branch Account page removal', () => {
  const removedPaths = [
    '/branch/products',
    '/branch/employees',
    '/branch/attendance',
    '/branch/reports',
    '/branch/analytics',
    '/branch/activity-logs',
    '/branch/settings',
    '/branch/notifications',
    '/branch/receipts',
    '/branch/profile',
  ];

  it.each(removedPaths)('redirects a branch session away from %s to its own dashboard', async (path) => {
    const token = fakeAccessToken({ role: 'branch', must_change_password: false, exp: Math.floor(Date.now() / 1000) + 900 });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { access_token: token }, error: null, meta: null }), { status: 200 }),
    );

    const request = makeRequest(`https://app.potatocorner.test${path}`, 'refresh_token=good-token');
    const response = await middleware(request);

    expect(requireLocation(response).pathname).toBe('/branch/dashboard');
  });

  it.each(removedPaths)('lets a staff session reach %s unchanged (no new restriction)', async (path) => {
    const token = fakeAccessToken({ role: 'staff', must_change_password: false, exp: Math.floor(Date.now() / 1000) + 900 });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { access_token: token }, error: null, meta: null }), { status: 200 }),
    );

    const request = makeRequest(`https://app.potatocorner.test${path}`, 'refresh_token=good-token');
    const response = await middleware(request);

    expect(response.headers.get('location')).toBeNull();
  });

  it('still lets a branch session reach /branch/terminal and /branch/dashboard (untouched)', async () => {
    const token = fakeAccessToken({ role: 'branch', must_change_password: false, exp: Math.floor(Date.now() / 1000) + 900 });
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { access_token: token }, error: null, meta: null }), { status: 200 }),
    );

    for (const path of ['/branch/terminal', '/branch/dashboard', '/branch/sales', '/branch/inventory']) {
      const request = makeRequest(`https://app.potatocorner.test${path}`, 'refresh_token=good-token');
      const response = await middleware(request);
      expect(response.headers.get('location')).toBeNull();
    }
  });
});

describe('POS-PERF-P44R — matcher exempts only the generated PWA scripts', () => {
  // Same compiled matcher Next.js applies at runtime, fed this file's own config.
  const runsMiddleware = (path: string) => unstable_doesMiddlewareMatch({ config, url: `https://app.potatocorner.test${path}` });

  it('serves next-pwa/workbox generated scripts (and their maps) without the login redirect', () => {
    for (const path of [
      '/sw.js',
      '/sw.js.map',
      '/workbox-5194662c.js',
      '/workbox-5194662c.js.map',
      '/swe-worker-5c72df51bb1f6ee0.js',
      '/swe-worker-5c72df51bb1f6ee0.js.map',
    ]) {
      expect(runsMiddleware(path), path).toBe(false);
    }
  });

  it('still runs on app pages, the login page and lookalike or non-generated script paths', () => {
    for (const path of [
      '/',
      '/login',
      '/admin/dashboard',
      '/branch/terminal',
      '/swe-worker-admin',
      '/swe-worker-.js',
      '/swe-worker-NOTHEX.js',
      '/swe-worker-5c72df51bb1f6ee0.js/admin',
      '/swe-worker-5c72df51bb1f6ee0.jsx',
      '/sw.js/admin',
      '/sw.json',
      '/sw.jsx',
      '/workbox-admin',
      '/workbox-5194662c.js.html',
      '/admin/swe-worker-5c72df51bb1f6ee0.js',
      '/admin/sw.js',
      '/worker.js',
      '/private.js',
    ]) {
      expect(runsMiddleware(path), path).toBe(true);
    }
  });

  it('redirects a signed-out lookalike worker path to /login', async () => {
    const response = await middleware(makeRequest('https://app.potatocorner.test/swe-worker-admin'));
    expect(requireLocation(response).pathname).toBe('/login');
  });
});
