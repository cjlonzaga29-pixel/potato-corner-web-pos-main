import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Task 209.6 — Product Image Management (Admin Only). Only Admin may
 * upload/replace/delete a product's image; Supervisor/Branch keep the same
 * read access they already have to products (adminSupervisorOrBranch).
 * Checked against the real authorize() middleware chain rather than mocked
 * away, same technique as product-categories.router.test.ts and
 * cash.router.test.ts — no supertest/HTTP harness, so multer's own
 * multipart parsing is exercised at the router-wiring level only (does the
 * chain reach the finalizer with req.file set?), not via a real multipart
 * request; the compression/Storage/repository logic it hands off to is
 * covered by products.service.test.ts.
 */
vi.mock('./products.service.js', () => ({
  productsService: {
    getProductImage: vi.fn(),
    uploadProductImage: vi.fn(),
    deleteProductImage: vi.fn(),
  },
}));

vi.mock('../flavors/flavors.service.js', () => ({ flavorsService: {} }));
vi.mock('../product-options/product-options.service.js', () => ({ productOptionsService: {} }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { productsService } = await import('./products.service.js');
const { productsRouter } = await import('./products.router.js');
const { generateSuperAdminToken, generateBranchToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/products', ...overrides } as unknown as Request;
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

async function runHandlers(handlers: Middleware[], req: Request, res: Response): Promise<number> {
  let ran = 0;
  for (const handler of handlers) {
    let calledNext = false;
    await handler(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    ran += 1;
    if (!calledNext) return ran;
  }
  return ran;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('GET /api/products/:productId/image — read access mirrors product read (adminSupervisorOrBranch)', () => {
  it.each([
    ['super_admin', () => generateSuperAdminToken()],
    ['supervisor', () => generateSupervisorToken([randomUUID()])],
    ['branch', () => generateBranchToken(randomUUID())],
  ])('lets a %s actor through to the service', async (_label, tokenFn) => {
    vi.mocked(productsService.getProductImage).mockResolvedValue({ image_url: 'https://example.com/signed.webp' });
    const handlers = getRouteHandlers(productsRouter, 'get', '/:productId/image');
    const req = mockReq({ ...authHeader(tokenFn()), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productsService.getProductImage).toHaveBeenCalledWith('prod-1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects an unauthenticated request with 401, never reaching the service', async () => {
    const handlers = getRouteHandlers(productsRouter, 'get', '/:productId/image');
    const req = mockReq({ params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(productsService.getProductImage).not.toHaveBeenCalled();
  });
});

describe('POST /api/products/:productId/image — Admin only', () => {
  it('rejects a branch actor with 403, never reaching multer or the service (unauthorized upload)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/image');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), params: { productId: 'prod-1' } });
    const res = mockRes();

    const ran = await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.uploadProductImage).not.toHaveBeenCalled();
    // Confirms the 403 fired at the authorize() step (index 1: authenticate,
    // adminOnly), before ever reaching multer's parsing middleware.
    expect(ran).toBe(2);
  });

  it('rejects a supervisor actor with 403, never reaching multer or the service (unauthorized upload)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/image');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.uploadProductImage).not.toHaveBeenCalled();
  });

  it('rejects the finalizer with 422 IMAGE_REQUIRED when multer found no file', async () => {
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/image');
    const finalizer = handlers[handlers.length - 1] as Middleware;
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      params: { productId: 'prod-1' },
      user: { user_id: 'admin-1', role: 'super_admin', email: 'a@test.com' },
    } as never);
    const res = mockRes();

    await finalizer(req, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(productsService.uploadProductImage).not.toHaveBeenCalled();
  });

  it('calls the service with the parsed file once multer has populated req.file (super_admin allowed through)', async () => {
    vi.mocked(productsService.uploadProductImage).mockResolvedValue({ image_url: 'https://example.com/signed.webp' });
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/image');
    const finalizer = handlers[handlers.length - 1] as Middleware;
    const req = mockReq({
      params: { productId: 'prod-1' },
      user: { user_id: 'admin-1', role: 'super_admin', email: 'a@test.com' },
      file: { buffer: Buffer.from('fake'), originalname: 'photo.jpg' },
      ip: '127.0.0.1',
    } as never);
    const res = mockRes();

    await finalizer(req, res, vi.fn() as NextFunction);

    expect(productsService.uploadProductImage).toHaveBeenCalledWith(
      'prod-1',
      { buffer: Buffer.from('fake'), originalname: 'photo.jpg' },
      { id: 'admin-1', role: 'super_admin' },
      '127.0.0.1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('DELETE /api/products/:productId/image — Admin only', () => {
  it('rejects a branch actor with 403, never reaching the service (unauthorized delete)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'delete', '/:productId/image');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.deleteProductImage).not.toHaveBeenCalled();
  });

  it('rejects a supervisor actor with 403, never reaching the service (unauthorized delete)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'delete', '/:productId/image');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.deleteProductImage).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(productsService.deleteProductImage).mockResolvedValue({ image_url: null });
    const handlers = getRouteHandlers(productsRouter, 'delete', '/:productId/image');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productsService.deleteProductImage).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
