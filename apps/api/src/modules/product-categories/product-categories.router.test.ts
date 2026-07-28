import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * CR-008 R13 — Product Category identity is Admin-owned; Branch has no
 * write access, and only the router-level authorize() middleware enforces
 * that (the service layer trusts its caller), so this is checked against
 * the real middleware chain rather than mocked away. Follows the same
 * mock-req/res technique as flavors.router.test.ts.
 */
vi.mock('./product-categories.service.js', () => ({
  productCategoriesService: {
    getAllCategories: vi.fn(),
    getCategoryById: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { productCategoriesService } = await import('./product-categories.service.js');
const { productCategoriesRouter } = await import('./product-categories.router.js');
const { generateSuperAdminToken, generateBranchToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/product-categories', ...overrides } as unknown as Request;
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

describe('POST /api/product-categories — authorization (R13)', () => {
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(productCategoriesRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), body: { code: 'fries', name: 'Fries' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productCategoriesService.createCategory).not.toHaveBeenCalled();
  });

  it('rejects a supervisor actor with 403 (read-only per R13)', async () => {
    const handlers = getRouteHandlers(productCategoriesRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), body: { code: 'fries', name: 'Fries' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productCategoriesService.createCategory).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(productCategoriesService.createCategory).mockResolvedValue({ id: 'cat-1' } as never);
    const handlers = getRouteHandlers(productCategoriesRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), body: { code: 'fries', name: 'Fries' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productCategoriesService.createCategory).toHaveBeenCalled();
  });
});
