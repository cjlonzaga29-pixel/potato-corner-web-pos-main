import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Follows the technique established in inventory.router.test.ts: no
 * supertest/HTTP-harness dependency is installed, so the real middleware
 * chain (authenticate, authorize guards, requirePasswordChange, validate)
 * runs directly against mock req/res objects, with only the service layer
 * mocked.
 */
vi.mock('./product-inventory.service.js', () => ({
  productInventoryService: {
    listByVariant: vi.fn(),
    createMapping: vi.fn(),
    updateMapping: vi.fn(),
    deleteMapping: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { productInventoryService } = await import('./product-inventory.service.js');
const { productInventoryRouter } = await import('./product-inventory.router.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/product-inventory/test', ...overrides } as unknown as Request;
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

const BRANCH_1 = randomUUID();
const VARIANT_1 = randomUUID();
const INGREDIENT_1 = randomUUID();

const VALID_BODY = {
  branch_id: BRANCH_1,
  product_variant_id: VARIANT_1,
  ingredient_id: INGREDIENT_1,
  quantity_required: 2.5,
  unit: 'g',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('GET / — list query requires branch_id', () => {
  it('rejects a query missing branch_id with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'get', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { product_variant_id: VARIANT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) }));
    expect(productInventoryService.listByVariant).not.toHaveBeenCalled();
  });

  it('rejects a query with an empty-string branch_id with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'get', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { branch_id: '', product_variant_id: VARIANT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) }));
    expect(productInventoryService.listByVariant).not.toHaveBeenCalled();
  });

  it('accepts a valid branch_id and forwards branch_id then product_variant_id unchanged to productInventoryService.listByVariant', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'get', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1, product_variant_id: VARIANT_1 } });
    const res = mockRes();
    vi.mocked(productInventoryService.listByVariant).mockResolvedValue([{ id: 'row-1' }] as never);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.listByVariant).toHaveBeenCalledWith(BRANCH_1, VARIANT_1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: { mappings: [{ id: 'row-1' }] }, error: null, meta: null });
  });
});

describe('POST / — validate middleware requires branch_id', () => {
  it('rejects a payload missing branch_id with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const { branch_id, ...withoutBranchId } = VALID_BODY;
    void branch_id;
    const req = mockReq({ ...authHeader(token), body: withoutBranchId });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) }));
    expect(productInventoryService.createMapping).not.toHaveBeenCalled();
  });

  it('accepts a valid branch_id, passes validation, and forwards branch_id plus the caller\'s allowed branch_ids (from the JWT) to productInventoryService.createMapping', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();
    vi.mocked(productInventoryService.createMapping).mockResolvedValue({ id: 'row-1' } as never);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.createMapping).toHaveBeenCalledWith(
      {
        branch_id: BRANCH_1,
        product_variant_id: VARIANT_1,
        ingredient_id: INGREDIENT_1,
        quantity_required: 2.5,
        unit: 'g',
      },
      [BRANCH_1],
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('passes every allowed branch_id for a supervisor with multiple branches', async () => {
    const BRANCH_2 = randomUUID();
    const handlers = getRouteHandlers(productInventoryRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1, BRANCH_2]);
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();
    vi.mocked(productInventoryService.createMapping).mockResolvedValue({ id: 'row-1' } as never);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.createMapping).toHaveBeenCalledWith(
      expect.objectContaining({ branch_id: BRANCH_1 }),
      [BRANCH_1, BRANCH_2],
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
  });

  it('returns the project\'s existing forbidden convention when the service rejects data.branch_id as outside the caller\'s accessible branches', async () => {
    const { ProductInventoryError } = await import('./product-inventory.types.js');
    const handlers = getRouteHandlers(productInventoryRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: VALID_BODY });
    const res = mockRes();
    vi.mocked(productInventoryService.createMapping).mockRejectedValue(
      new ProductInventoryError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403),
    );

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }) }));
  });
});

describe('PATCH /:id — branch-scoped update', () => {
  it('forwards the caller\'s allowed branch_ids (from the JWT, not the body) to productInventoryService.updateMapping, preserving the existing update payload fields', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'patch', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'row-1' }, body: { quantity_required: 3, unit: 'kg' } });
    const res = mockRes();
    vi.mocked(productInventoryService.updateMapping).mockResolvedValue({ id: 'row-1', unit: 'kg' } as never);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.updateMapping).toHaveBeenCalledWith(
      'row-1',
      { quantity_required: 3, unit: 'kg' },
      [BRANCH_1],
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: { id: 'row-1', unit: 'kg' }, error: null, meta: null });
  });

  it('passes every allowed branch_id for a supervisor with multiple branches', async () => {
    const BRANCH_2 = randomUUID();
    const handlers = getRouteHandlers(productInventoryRouter, 'patch', '/:id');
    const token = generateSupervisorToken([BRANCH_1, BRANCH_2]);
    const req = mockReq({ ...authHeader(token), params: { id: 'row-1' }, body: { unit: 'kg' } });
    const res = mockRes();
    vi.mocked(productInventoryService.updateMapping).mockResolvedValue({ id: 'row-1' } as never);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.updateMapping).toHaveBeenCalledWith(
      'row-1',
      { unit: 'kg' },
      [BRANCH_1, BRANCH_2],
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
  });

  it('returns the project\'s existing not-found error/status when the service reports the mapping as not found (e.g. it belongs to another branch)', async () => {
    const { ProductInventoryError } = await import('./product-inventory.types.js');
    const handlers = getRouteHandlers(productInventoryRouter, 'patch', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'row-1' }, body: { unit: 'kg' } });
    const res = mockRes();
    vi.mocked(productInventoryService.updateMapping).mockRejectedValue(
      new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404),
    );

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'PRODUCT_INVENTORY_NOT_FOUND' }) }));
  });
});

describe('DELETE /:id — branch-scoped delete', () => {
  it('forwards the caller\'s allowed branch_ids (from the JWT) to productInventoryService.deleteMapping, preserving the existing request shape and 204 response', async () => {
    const handlers = getRouteHandlers(productInventoryRouter, 'delete', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'row-1' } });
    const res = mockRes();
    vi.mocked(productInventoryService.deleteMapping).mockResolvedValue(undefined);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.deleteMapping).toHaveBeenCalledWith(
      'row-1',
      [BRANCH_1],
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });

  it('passes every allowed branch_id for a supervisor with multiple branches', async () => {
    const BRANCH_2 = randomUUID();
    const handlers = getRouteHandlers(productInventoryRouter, 'delete', '/:id');
    const token = generateSupervisorToken([BRANCH_1, BRANCH_2]);
    const req = mockReq({ ...authHeader(token), params: { id: 'row-1' } });
    const res = mockRes();
    vi.mocked(productInventoryService.deleteMapping).mockResolvedValue(undefined);

    await runHandlers(handlers, req, res);

    expect(productInventoryService.deleteMapping).toHaveBeenCalledWith(
      'row-1',
      [BRANCH_1, BRANCH_2],
      expect.objectContaining({ id: expect.any(String) }),
      null,
    );
  });

  it('returns the project\'s existing not-found error/status when the service reports the mapping as not found (e.g. it belongs to another branch)', async () => {
    const { ProductInventoryError } = await import('./product-inventory.types.js');
    const handlers = getRouteHandlers(productInventoryRouter, 'delete', '/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: 'row-1' } });
    const res = mockRes();
    vi.mocked(productInventoryService.deleteMapping).mockRejectedValue(
      new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404),
    );

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'PRODUCT_INVENTORY_NOT_FOUND' }) }));
  });
});
