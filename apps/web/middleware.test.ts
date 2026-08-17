import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

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
