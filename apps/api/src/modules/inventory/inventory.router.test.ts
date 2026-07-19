import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * No `.router.test.ts` file existed anywhere in this codebase before this
 * one, and there's no supertest/HTTP-harness dependency installed (and we
 * can't add one — no new packages). This follows rbac.test.ts's own
 * established technique instead: run the *real* middleware chain
 * (authenticate, authorize guards, branchGuard, requirePasswordChange,
 * validate) directly against mock req/res objects, with only the service
 * layer mocked. The one addition rbac.test.ts didn't need is pulling a
 * specific route's handler chain out of the Router instance itself — Express
 * 5 exposes this via `router.stack[i].route.stack[j].handle`.
 */
vi.mock('./inventory.service.js', () => ({
  inventoryService: {
    listIngredients: vi.fn(),
    getIngredientById: vi.fn(),
    createIngredient: vi.fn(),
    updateIngredient: vi.fn(),
    deleteIngredient: vi.fn(),
    stockIn: vi.fn(),
    adjustIngredient: vi.fn(),
    wasteIngredient: vi.fn(),
    getBranchInventory: vi.fn(),
    getBranchAlerts: vi.fn(),
    submitPhysicalCount: vi.fn(),
    transferStock: vi.fn(),
    getMovements: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { inventoryService } = await import('./inventory.service.js');
const { IngredientError } = await import('./inventory.types.js');
const { inventoryRouter, inventoryBranchRouter } = await import('./inventory.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import(
  '../../test-utils/auth-tokens.js'
);

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  // requirePasswordChange reads req.originalUrl unconditionally (to check
  // against its exempt-path set) — a non-exempt placeholder here keeps it
  // from throwing on every route past the auth/role guards.
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/inventory/test', ...overrides } as unknown as Request;
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

/** Pulls the exact ordered [middleware..., handler] chain Express would run for one route, straight off the Router instance — see file header comment. */
function getRouteHandlers(router: Router, method: string, path: string): Middleware[] {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Middleware }> } };
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

/** Runs a handler chain like Express would: stops at the first handler that doesn't call next() — either a guard rejected the request, or the terminal handler already sent a response. */
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
const BRANCH_2 = randomUUID();
const INGREDIENT_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('inventory routes — authentication', () => {
  const protectedRoutes: Array<{ router: Router; method: string; path: string }> = [
    { router: inventoryRouter, method: 'get', path: '/ingredients' },
    { router: inventoryRouter, method: 'post', path: '/ingredients' },
    { router: inventoryRouter, method: 'patch', path: '/ingredients/:id' },
    { router: inventoryRouter, method: 'delete', path: '/ingredients/:id' },
    { router: inventoryRouter, method: 'post', path: '/ingredients/:id/stock-in' },
    { router: inventoryBranchRouter, method: 'get', path: '/:branchId/inventory' },
    { router: inventoryBranchRouter, method: 'post', path: '/:branchId/inventory/transfer' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ router, method, path }) => {
    const handlers = getRouteHandlers(router, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(inventoryService.listIngredients).not.toHaveBeenCalled();
  });
});

describe('POST /ingredients — role guard', () => {
  it('staff token is rejected with 403', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'post', '/ingredients');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(inventoryService.createIngredient).not.toHaveBeenCalled();
  });

  it('supervisor token is rejected with 403 — only super_admin may create ingredients', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'post', '/ingredients');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(inventoryService.createIngredient).not.toHaveBeenCalled();
  });

  it('super_admin token passes the guard and reaches the service', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'post', '/ingredients');
    const token = generateSuperAdminToken();
    const req = mockReq({
      ...authHeader(token),
      body: { branch_id: BRANCH_1, name: 'Potato', unit: 'kg', current_stock: 0, low_stock_threshold: 10, critical_threshold: 5 },
    });
    const res = mockRes();
    vi.mocked(inventoryService.createIngredient).mockResolvedValue({ id: INGREDIENT_1 } as never);

    await runHandlers(handlers, req, res);

    expect(inventoryService.createIngredient).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('PATCH /ingredients/:id and DELETE /ingredients/:id — staff cannot mutate ingredients', () => {
  it('staff token is rejected on PATCH with 403', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'patch', '/ingredients/:id');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 }, body: { name: 'x' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(inventoryService.updateIngredient).not.toHaveBeenCalled();
  });

  it('staff token is rejected on DELETE with 403', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'delete', '/ingredients/:id');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(inventoryService.deleteIngredient).not.toHaveBeenCalled();
  });

  it('supervisor token is also rejected on DELETE with 403 — ingredient CRUD is adminOnly, not adminOrSupervisor', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'delete', '/ingredients/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('GET /:branchId/inventory — branchGuard', () => {
  it("blocks a supervisor from accessing another branch's inventory — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(inventoryBranchRouter, 'get', '/:branchId/inventory');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_2 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
    expect(inventoryService.getBranchInventory).not.toHaveBeenCalled();
  });

  it('allows a supervisor to access their own branch inventory', async () => {
    const handlers = getRouteHandlers(inventoryBranchRouter, 'get', '/:branchId/inventory');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(inventoryService.getBranchInventory).mockResolvedValue({ branch_id: BRANCH_1, ingredients: [] } as never);

    await runHandlers(handlers, req, res);

    expect(inventoryService.getBranchInventory).toHaveBeenCalledWith(BRANCH_1);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /ingredients/:id — branch protection', () => {
  // branchGuard itself can't run on this route (no :branchId in the URL —
  // see the inline comment in inventory.router.ts), so this exercises the
  // router's own inline branch check instead, added to close an information
  // disclosure gap where any supervisor could look up another branch's
  // ingredient by id.
  it("blocks a supervisor from fetching another branch's ingredient — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'get', '/ingredients/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 } });
    const res = mockRes();
    vi.mocked(inventoryService.getIngredientById).mockResolvedValue({ id: INGREDIENT_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('allows a supervisor to fetch an ingredient belonging to their own branch — 200', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'get', '/ingredients/:id');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 } });
    const res = mockRes();
    vi.mocked(inventoryService.getIngredientById).mockResolvedValue({ id: INGREDIENT_1, branch_id: BRANCH_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { id: INGREDIENT_1, branch_id: BRANCH_1 } }));
  });

  it('allows a super_admin to fetch any ingredient regardless of branch — 200', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'get', '/ingredients/:id');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 } });
    const res = mockRes();
    vi.mocked(inventoryService.getIngredientById).mockResolvedValue({ id: INGREDIENT_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { id: INGREDIENT_1, branch_id: BRANCH_2 } }));
  });
});

describe('POST /ingredients/:id/stock-in — validate middleware', () => {
  it('rejects a payload missing the required quantity field with 422 VALIDATION_ERROR', async () => {
    // Every route in this codebase returns 422 (not 400) for a failed
    // validate(schema) check — see middleware/validate.ts and every other
    // module's router (e.g. price-overrides.router.ts's listQuerySchema
    // handler). Asserting 400 here would test for behavior this codebase
    // deliberately doesn't have.
    const handlers = getRouteHandlers(inventoryRouter, 'post', '/ingredients/:id/stock-in');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 }, body: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) }));
    expect(inventoryService.stockIn).not.toHaveBeenCalled();
  });

  it('a valid stock-in request passes validate() and reaches the service, returning 201', async () => {
    const handlers = getRouteHandlers(inventoryRouter, 'post', '/ingredients/:id/stock-in');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { id: INGREDIENT_1 }, body: { quantity: 25 } });
    const res = mockRes();
    vi.mocked(inventoryService.stockIn).mockResolvedValue({ id: 'mov-1' } as never);

    await runHandlers(handlers, req, res);

    expect(inventoryService.stockIn).toHaveBeenCalledWith(INGREDIENT_1, { quantity: 25 }, expect.objectContaining({ id: expect.any(String) }), null);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { id: 'mov-1' }, error: null }));
  });
});

describe('POST /:branchId/inventory/transfer — same-branch transfer rejection', () => {
  it('surfaces the service-layer INVALID_TRANSFER rejection as 422, not a 500', async () => {
    // transferIngredientSchema has no from/to-branch-equality rule of its
    // own to reject at validate() — `to_branch_id === :branchId` is a
    // cross-field business rule enforced in inventoryService.transferStock
    // (see inventory.service.test.ts's "rejects a transfer where the
    // destination equals the source branch" test for the rule itself).
    // What belongs here, at the router layer, is confirming the router's
    // error handler correctly maps that thrown domain error to a 422
    // response instead of letting it fall through as an unhandled 500.
    const handlers = getRouteHandlers(inventoryBranchRouter, 'post', '/:branchId/inventory/transfer');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({
      ...authHeader(token),
      params: { branchId: BRANCH_1 },
      body: { ingredient_id: INGREDIENT_1, to_branch_id: BRANCH_1, quantity: 5 },
    });
    const res = mockRes();
    vi.mocked(inventoryService.transferStock).mockRejectedValue(
      new IngredientError('INVALID_TRANSFER', 'Cannot transfer stock to the same branch', 422),
    );

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_TRANSFER' }) }));
  });
});
