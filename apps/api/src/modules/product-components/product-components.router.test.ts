import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Follows the technique established in product-inventory.router.test.ts: no
 * supertest/HTTP-harness dependency is installed, so the real middleware
 * chain (authenticate, authorize guards, requirePasswordChange, validate)
 * runs directly against mock req/res objects, with only the service layer
 * mocked.
 */
vi.mock('./product-components.service.js', () => ({
  productComponentsService: {
    listByVariant: vi.fn(),
    createMapping: vi.fn(),
    updateMapping: vi.fn(),
    deleteMapping: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    revokedToken: { findFirst: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ status: 'active', isActive: true }) },
  },
}));

const { prisma } = await import('../../lib/prisma.js');
const { productComponentsService } = await import('./product-components.service.js');
const { productComponentsRouter } = await import('./product-components.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateBranchToken, generateStaffToken } = await import(
  '../../test-utils/auth-tokens.js'
);

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/product-components/test', ...overrides } as unknown as Request;
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

const VARIANT_1 = randomUUID();
const BRANCH_1 = randomUUID();

const VALID_BODY = {
  product_variant_id: VARIANT_1,
  inventory_item_id: randomUUID(),
  quantity_required: 2.5,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('GET / — Admin and Supervisor read access', () => {
  it('allows super_admin to list components', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { product_variant_id: VARIANT_1 } });
    const res = mockRes();
    vi.mocked(productComponentsService.listByVariant).mockResolvedValue([{ id: 'c1' }] as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(productComponentsService.listByVariant).toHaveBeenCalledWith(VARIANT_1);
  });

  it('allows supervisor to list components', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'get', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { product_variant_id: VARIANT_1 } });
    const res = mockRes();
    vi.mocked(productComponentsService.listByVariant).mockResolvedValue([] as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects branch-role callers with 403', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'get', '/');
    const token = generateBranchToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: { product_variant_id: VARIANT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productComponentsService.listByVariant).not.toHaveBeenCalled();
  });

  it('rejects staff-role callers with 403', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'get', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: { product_variant_id: VARIANT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productComponentsService.listByVariant).not.toHaveBeenCalled();
  });

  it('rejects a query missing product_variant_id with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(productComponentsService.listByVariant).not.toHaveBeenCalled();
  });
});

describe('POST / — Supervisor-only write access (ownership-scoped in the service)', () => {
  it('rejects super_admin with 403 (POS-PERF-P35 — write access moved to Supervisor)', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'post', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productComponentsService.createMapping).not.toHaveBeenCalled();
  });

  // POS-PERF-P34R — reaches the service layer now; ownership (does the
  // supervisor own the parent product?) is enforced in
  // productComponentsService.assertParentProductWritable, not here.
  it('allows a supervisor through the router to the service', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();
    vi.mocked(productComponentsService.createMapping).mockResolvedValue({ id: 'c1' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(productComponentsService.createMapping).toHaveBeenCalledWith(
      VALID_BODY,
      expect.objectContaining({ id: expect.any(String), role: 'supervisor' }),
      null,
    );
  });

  it('rejects branch-role callers with 403', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'post', '/');
    const token = generateBranchToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productComponentsService.createMapping).not.toHaveBeenCalled();
  });

  it('rejects a payload with quantity_required <= 0 with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { ...VALID_BODY, quantity_required: 0 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(productComponentsService.createMapping).not.toHaveBeenCalled();
  });

  it('returns 409 MAPPING_ALREADY_EXISTS when the service rejects a duplicate', async () => {
    const { ProductComponentError } = await import('./product-components.types.js');
    const handlers = getRouteHandlers(productComponentsRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();
    vi.mocked(productComponentsService.createMapping).mockRejectedValue(
      new ProductComponentError('MAPPING_ALREADY_EXISTS', 'This inventory item is already mapped to this variant', 409),
    );

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'MAPPING_ALREADY_EXISTS' }) }));
  });
});

describe('PATCH /:id — Supervisor-only write access', () => {
  it('rejects super_admin with 403 (POS-PERF-P35 — write access moved to Supervisor)', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'patch', '/:id');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: 'c1' }, body: { quantity_required: 4 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productComponentsService.updateMapping).not.toHaveBeenCalled();
  });

  it('allows a supervisor through the router to the service', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'patch', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'c1' }, body: { quantity_required: 4 } });
    const res = mockRes();
    vi.mocked(productComponentsService.updateMapping).mockResolvedValue({ id: 'c1', quantity_required: 4 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(productComponentsService.updateMapping).toHaveBeenCalledWith(
      'c1',
      { quantity_required: 4 },
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
  });

  it('rejects a payload with quantity_required <= 0 with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'patch', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'c1' }, body: { quantity_required: -1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(productComponentsService.updateMapping).not.toHaveBeenCalled();
  });
});

describe('DELETE /:id — Supervisor-only write access', () => {
  it('rejects super_admin with 403 (POS-PERF-P35 — write access moved to Supervisor)', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'delete', '/:id');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: 'c1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productComponentsService.deleteMapping).not.toHaveBeenCalled();
  });

  it('allows a supervisor through the router to the service', async () => {
    const handlers = getRouteHandlers(productComponentsRouter, 'delete', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'c1' } });
    const res = mockRes();
    vi.mocked(productComponentsService.deleteMapping).mockResolvedValue(undefined);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(204);
  });
});
