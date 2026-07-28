import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * CR-010 R7 regression coverage — standalone Flavor creation must stay
 * disabled at the API boundary even though flavorsService.createFlavor
 * itself is untouched (see flavors.router.ts). Follows the same
 * mock-req/res-against-the-real-middleware-chain technique as
 * product-inventory.router.test.ts.
 */
vi.mock('./flavors.service.js', () => ({
  flavorsService: {
    getAllFlavors: vi.fn(),
    getFlavorById: vi.fn(),
    createFlavor: vi.fn(),
    updateFlavor: vi.fn(),
    getFlavorBranchAvailability: vi.fn(),
    updateBranchFlavorAvailability: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { flavorsService } = await import('./flavors.service.js');
const { flavorsRouter } = await import('./flavors.router.js');
const { generateSuperAdminToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/flavors', ...overrides } as unknown as Request;
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
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('POST /api/flavors — standalone Flavor creation disabled (CR-010 R7)', () => {
  it('returns 403 FLAVOR_CREATION_DISABLED for a super_admin, without calling the service', async () => {
    const handlers = getRouteHandlers(flavorsRouter, 'post', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { name: 'New Flavor', color_hex: '#FFD700', is_active: true } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'FLAVOR_CREATION_DISABLED' }) }));
    expect(flavorsService.createFlavor).not.toHaveBeenCalled();
  });

  it('rejects a branch-role token before it ever reaches the disabled-creation handler', async () => {
    const handlers = getRouteHandlers(flavorsRouter, 'post', '/');
    const token = generateBranchToken(randomUUID());
    const req = mockReq({ ...authHeader(token), body: { name: 'New Flavor', color_hex: '#FFD700', is_active: true } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(flavorsService.createFlavor).not.toHaveBeenCalled();
  });
});
