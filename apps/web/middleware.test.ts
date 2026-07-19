import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

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

describe('middleware /login redirect preserves returnTo', () => {
  it('appends the original path+query as ?returnTo= when there is no refresh cookie at all', async () => {
    const request = makeRequest('https://app.potatocorner.test/admin/reports?tab=sales');
    const response = await middleware(request);

    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/admin/reports?tab=sales');
  });

  it('appends returnTo when the refresh cookie is present but genuinely invalid (REFRESH_INVALID, 401)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: null, error: { code: 'REFRESH_INVALID' } }), { status: 401 }),
    );

    const request = makeRequest('https://app.potatocorner.test/supervisor/reports', 'refresh_token=dead-token');
    const response = await middleware(request);

    const location = new URL(response.headers.get('location')!);
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
});
