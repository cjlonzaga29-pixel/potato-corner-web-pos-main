import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Task 209.6 / POS-PERF-P34 — Product Image Management. Upload is now
 * Admin-or-Supervisor at the router/authorize level (Supervisor creates
 * products, and the creation form immediately uploads an optional image);
 * ownership scoping — a Supervisor may only upload to a product they
 * created — is enforced inside productsService.uploadProductImage, not at
 * this middleware layer, so it isn't observable in these router-wiring
 * tests (the service is mocked). Delete stays Admin-only. Branch keeps the
 * same read access it already has to products (adminSupervisorOrBranch).
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
    publishProductToBranches: vi.fn(),
  },
}));

vi.mock('../flavors/flavors.service.js', () => ({ flavorsService: {} }));
vi.mock('../product-options/product-options.service.js', () => ({ productOptionsService: {} }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    revokedToken: { findFirst: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ status: 'active', isActive: true }) },
  },
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

describe('GET /api/products/:productId/image — read access mirrors product read (adminOrSupervisor)', () => {
  it.each([
    ['super_admin', () => generateSuperAdminToken()],
    ['supervisor', () => generateSupervisorToken([randomUUID()])],
  ])('lets a %s actor through to the service', async (_label, tokenFn) => {
    vi.mocked(productsService.getProductImage).mockResolvedValue({ image_url: 'https://example.com/signed.webp' });
    const handlers = getRouteHandlers(productsRouter, 'get', '/:productId/image');
    const req = mockReq({ ...authHeader(tokenFn()), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productsService.getProductImage).toHaveBeenCalledWith('prod-1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // POS-PERF-P26 — the Branch Account's Products management page was
  // removed; it now reads the catalog (GET /catalog, allRoles) instead of
  // product identity endpoints like this one.
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(productsRouter, 'get', '/:productId/image');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.getProductImage).not.toHaveBeenCalled();
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

describe('POST /api/products/:productId/image — Admin or Supervisor', () => {
  it('rejects a branch actor with 403, never reaching multer or the service (unauthorized upload)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/image');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), params: { productId: 'prod-1' } });
    const res = mockRes();

    const ran = await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.uploadProductImage).not.toHaveBeenCalled();
    // Confirms the 403 fired at the authorize() step (index 1: authenticate,
    // adminOrSupervisor), before ever reaching multer's parsing middleware.
    expect(ran).toBe(2);
  });

  it('lets a supervisor actor through authorize() to the finalizer (ownership is enforced in the service, not here)', async () => {
    vi.mocked(productsService.uploadProductImage).mockResolvedValue({ image_url: 'https://example.com/signed.webp' });
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/image');
    const finalizer = handlers[handlers.length - 1] as Middleware;
    const req = mockReq({
      params: { productId: 'prod-1' },
      user: { user_id: 'supervisor-1', role: 'supervisor', email: 's@test.com' },
      file: { buffer: Buffer.from('fake'), originalname: 'photo.jpg' },
      ip: '127.0.0.1',
    } as never);
    const res = mockRes();

    await finalizer(req, res, vi.fn() as NextFunction);

    expect(productsService.uploadProductImage).toHaveBeenCalledWith(
      'prod-1',
      { buffer: Buffer.from('fake'), originalname: 'photo.jpg' },
      { id: 'supervisor-1', role: 'supervisor' },
      '127.0.0.1',
    );
    expect(res.status).toHaveBeenCalledWith(200);
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

describe('DELETE /api/products/:productId/image — Supervisor only', () => {
  it('rejects a branch actor with 403, never reaching the service (unauthorized delete)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'delete', '/:productId/image');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.deleteProductImage).not.toHaveBeenCalled();
  });

  it('rejects a super_admin actor with 403, never reaching the service (POS-PERF-P35 — write access moved to Supervisor)', async () => {
    const handlers = getRouteHandlers(productsRouter, 'delete', '/:productId/image');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.deleteProductImage).not.toHaveBeenCalled();
  });

  it('allows a supervisor actor through to the service', async () => {
    vi.mocked(productsService.deleteProductImage).mockResolvedValue({ image_url: null });
    const handlers = getRouteHandlers(productsRouter, 'delete', '/:productId/image');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), params: { productId: 'prod-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productsService.deleteProductImage).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// POS-PERF-P37 — multi-branch "Add to POS". Supervisor-only like /publish;
// no branchGuard (array body), so the service's own whole-selection
// authorization (covered by products.multi-branch-selection.integration.test.ts)
// is the branch check — these tests pin the role gate and body validation.
describe('POST /api/products/:productId/publish-branches — Supervisor only, validated branch_ids', () => {
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/publish-branches');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), params: { productId: 'prod-1' }, body: { branch_ids: [randomUUID()] } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.publishProductToBranches).not.toHaveBeenCalled();
  });

  it('rejects a super_admin actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/publish-branches');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), params: { productId: 'prod-1' }, body: { branch_ids: [randomUUID()] } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productsService.publishProductToBranches).not.toHaveBeenCalled();
  });

  it.each([[{ branch_ids: [] }], [{ branch_ids: ['not-a-uuid'] }], [{ branch_id: randomUUID() }]])(
    'rejects an invalid body %j with 422, never reaching the service',
    async (body) => {
      const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/publish-branches');
      const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), params: { productId: 'prod-1' }, body });
      const res = mockRes();

      await runHandlers(handlers, req, res);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(productsService.publishProductToBranches).not.toHaveBeenCalled();
    },
  );

  it('passes the whole selection to the service for a supervisor', async () => {
    const branchA = randomUUID();
    const branchB = randomUUID();
    vi.mocked(productsService.publishProductToBranches).mockResolvedValue({ product_id: 'prod-1', branches: [] });
    const handlers = getRouteHandlers(productsRouter, 'post', '/:productId/publish-branches');
    const req = mockReq({ ...authHeader(generateSupervisorToken([branchA, branchB])), params: { productId: 'prod-1' }, body: { branch_ids: [branchA, branchB] } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productsService.publishProductToBranches).toHaveBeenCalledWith('prod-1', [branchA, branchB], expect.objectContaining({ role: 'supervisor' }), null);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
