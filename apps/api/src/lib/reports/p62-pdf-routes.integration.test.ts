import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P62 — PDF routes over HTTP with the real app: a refused or stopped
 * render is a JSON answer with Retry-After, never an empty download; a real
 * render goes through the worker; authorization still runs first.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { app } = await import('../../app.js');
const { pdfRenderPool, PdfRenderError } = await import('./pdf-render-pool.js');
const { generateSuperAdminToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!canRunIntegrationTests)('P62 PDF routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // A range with no sales: the other suites' data must not push this past the route's row limit (422).
  const EMPTY_RANGE = '/api/transactions/export/pdf?date_from=2099-01-01&date_to=2099-01-02';
  const get = (path: string, token: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  it.each([
    ['PDF_BUSY', 503, '60'],
    ['PDF_TIMEOUT', 503, '60'],
    ['PDF_TOO_LARGE', 413, null],
    ['PDF_FAILED', 500, null],
  ] as const)('answers %s with JSON status %s, never a file', async (code, status, retryAfter) => {
    vi.spyOn(pdfRenderPool, 'render').mockRejectedValue(new PdfRenderError(code));
    const response = await get(EMPTY_RANGE, generateSuperAdminToken());
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('retry-after')).toBe(retryAfter);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it('renders a real Transaction PDF through the worker', async () => {
    const render = vi.spyOn(pdfRenderPool, 'render');
    const response = await get(EMPTY_RANGE, generateSuperAdminToken());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    expect(render).toHaveBeenCalledWith('transactions', expect.any(Array), expect.any(AbortSignal));
  }, 120_000);

  it('refuses an unauthorized role before any render is queued', async () => {
    const render = vi.spyOn(pdfRenderPool, 'render');
    const response = await get(EMPTY_RANGE, generateStaffToken('00000000-0000-0000-0000-000000000000'));
    expect(response.status).toBe(403);
    expect(render).not.toHaveBeenCalled();
  });
});
