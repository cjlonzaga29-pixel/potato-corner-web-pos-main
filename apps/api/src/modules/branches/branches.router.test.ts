import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as audit.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate, adminOnly, requirePasswordChange, multer) is pulled
 * straight off the Router instance and run against mock req/res objects,
 * with only the service layer mocked. Multer's own middleware calls
 * next() untouched when req's content-type isn't multipart (see
 * make-middleware.js's `if (!is(req, ['multipart'])) return next()`), so
 * a mock req with req.file preset simulates an already-parsed upload.
 */
vi.mock('./branches.service.js', () => ({
  branchesService: {
    bulkAssignGcashQr: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

const { branchesService } = await import('./branches.service.js');
const { branchesRouter } = await import('./branches.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    originalUrl: '/api/branches/gcash-qr/bulk-assign',
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response & { statusCode?: number; jsonBody?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as unknown as Response['json'];
  res.send = vi.fn(() => res) as unknown as Response['send'];
  return res;
}

function authHeader(token: string): Partial<Request> {
  return { headers: { authorization: `Bearer ${token}` } };
}

function getRouteHandlers(router: Router, method: string, path: string): Middleware[] {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Middleware }> } };
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runHandlers(handlers: Middleware[], req: Request, res: Response): Promise<void> {
  for (const handler of handlers) {
    let calledNext = false;
    await handler(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    if (!calledNext) return;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

const ROUTE = '/gcash-qr/bulk-assign';

describe('POST /api/branches/gcash-qr/bulk-assign — role guard', () => {
  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSupervisorToken([randomUUID()]);
    const res = mockRes();

    await runHandlers(handlers, mockReq(authHeader(token)), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateStaffToken(randomUUID());
    const res = mockRes();

    await runHandlers(handlers, mockReq(authHeader(token)), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches/gcash-qr/bulk-assign — validation', () => {
  it('returns 422 when the file is missing', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(handlers, mockReq(authHeader(token)), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });

  it('returns 422 when branchIds is not valid JSON', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
      body: { branchIds: 'not-json' },
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });

  it('returns 422 when branchIds fails schema validation', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
      body: { branchIds: JSON.stringify([]) },
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches/gcash-qr/bulk-assign — success', () => {
  it('returns 200 with the partial-success shape', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();
    const branchId1 = randomUUID();
    const branchId2 = randomUUID();
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
      body: { branchIds: JSON.stringify([branchId1, branchId2]) },
    });
    vi.mocked(branchesService.bulkAssignGcashQr).mockResolvedValue({
      successful: [{ branchId: branchId1, gcashQrUrl: 'https://cdn.test/qr.webp' }],
      failed: [{ branchId: branchId2, error: 'Failed to upload the GCash QR image' }],
    });

    await runHandlers(handlers, req, res);

    expect(branchesService.bulkAssignGcashQr).toHaveBeenCalledWith(
      [branchId1, branchId2],
      { buffer: expect.any(Buffer), originalname: 'qr.png' },
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toMatchObject({
      data: {
        successful: [{ branchId: branchId1, gcashQrUrl: 'https://cdn.test/qr.webp' }],
        failed: [{ branchId: branchId2, error: 'Failed to upload the GCash QR image' }],
      },
      error: null,
    });
  });
});
