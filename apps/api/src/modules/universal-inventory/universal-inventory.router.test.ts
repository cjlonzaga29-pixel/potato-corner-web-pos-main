import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * CR-010 R9 regression coverage — Universal Inventory identity is
 * Admin/Super Admin owned; Supervisor gets read-only oversight; Branch has
 * no access at all (branch stock operations stay on the legacy
 * apps/api/src/modules/inventory endpoints, unchanged by this CR).
 */
vi.mock('./universal-inventory.service.js', () => ({
  universalInventoryService: {
    listCategories: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    listUnits: vi.fn(),
    createUnit: vi.fn(),
    updateUnit: vi.fn(),
    listConversions: vi.fn(),
    createConversion: vi.fn(),
    listItems: vi.fn(),
    getItemById: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    assignToBranches: vi.fn(),
    listItemConversions: vi.fn(),
    createItemConversion: vi.fn(),
    updateItemConversion: vi.fn(),
    deleteItemConversion: vi.fn(),
    getStockMovements: vi.fn(),
    transferStock: vi.fn(),
    getTransferDestinations: vi.fn(),
  },
}));

vi.mock('../inventory-migration/dry-run.service.js', () => ({
  runMigrationDryRun: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

// branchGuard/hasBranchAccess resolve Supervisor scope from the database via
// branch-access.ts, never the JWT's branch_ids — mocked here so the
// stockBranchRouter tests below don't depend on a real Prisma connection
// (same setup as inventory.router.test.ts).
vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { prisma } = await import('../../lib/prisma.js');
const { universalInventoryService } = await import('./universal-inventory.service.js');
const { universalInventoryRouter, inventoryStockBranchRouter } = await import('./universal-inventory.router.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { generateSuperAdminToken, generateSupervisorToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/universal-inventory/items', ...overrides } as unknown as Request;
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
const BRANCH_2 = randomUUID();
const UNIT_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([BRANCH_1]);
});

describe('GET /api/universal-inventory/items', () => {
  it('rejects a branch-role token (branch has no identity-layer access)', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'get', '/items');
    const req = mockReq({ ...authHeader(generateBranchToken(BRANCH_1)) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.listItems).not.toHaveBeenCalled();
  });

  it('allows a supervisor token (read-only oversight)', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'get', '/items');
    const req = mockReq({ ...authHeader(generateSupervisorToken([BRANCH_1])) });
    const res = mockRes();
    vi.mocked(universalInventoryService.listItems).mockResolvedValue([]);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.listItems).toHaveBeenCalledWith(false);
  });
});

describe('POST /api/universal-inventory/items', () => {
  it('rejects a supervisor token — identity creation is Super Admin only', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      body: { name: 'Cheese Powder', base_unit_id: UNIT_1 },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.createItem).not.toHaveBeenCalled();
  });

  it('allows a super_admin token to create an item', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      body: { name: 'Cheese Powder', base_unit_id: UNIT_1 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.createItem).mockResolvedValue({ id: 'item-1' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(universalInventoryService.createItem).toHaveBeenCalledTimes(1);
  });

  it('maps the snake_case request body to the camelCase service input (regression: base_unit_id/category_id were never forwarded)', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items');
    const CATEGORY_1 = randomUUID();
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      body: { name: 'Frozen Fries', sku: 'RAW-001', category_id: CATEGORY_1, base_unit_id: UNIT_1 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.createItem).mockResolvedValue({ id: 'item-1' } as never);

    await runHandlers(handlers, req, res);

    expect(universalInventoryService.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Frozen Fries', sku: 'RAW-001', categoryId: CATEGORY_1, baseUnitId: UNIT_1 }),
      expect.anything(),
      null,
    );
  });

  it('accepts blank/omitted sku, barcode, and category as undefined rather than invalid empty values', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      body: { name: 'Frozen Fries', base_unit_id: UNIT_1 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.createItem).mockResolvedValue({ id: 'item-1' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(universalInventoryService.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ sku: undefined, barcode: undefined, categoryId: undefined }),
      expect.anything(),
      null,
    );
  });
});

describe('POST /api/universal-inventory/items/:itemId/branches', () => {
  it('rejects a branch-role token', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items/:itemId/branches');
    const req = mockReq({ ...authHeader(generateBranchToken(BRANCH_1)), params: { itemId: 'item-1' }, body: { branch_ids: [BRANCH_1] } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.assignToBranches).not.toHaveBeenCalled();
  });

  it('forwards assignment to the service for a super_admin token', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items/:itemId/branches');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      params: { itemId: 'item-1' },
      body: { branch_ids: [BRANCH_1] },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.assignToBranches).mockResolvedValue({ assigned: [BRANCH_1], already_assigned: [] });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.assignToBranches).toHaveBeenCalledWith('item-1', [BRANCH_1], expect.any(Object), null);
  });
});

// --- Item-specific unit conversions (TASK 121) ---

describe('GET /api/universal-inventory/items/:itemId/conversions', () => {
  it('rejects a branch-role token', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'get', '/items/:itemId/conversions');
    const req = mockReq({ ...authHeader(generateBranchToken(BRANCH_1)), params: { itemId: 'item-1' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.listItemConversions).not.toHaveBeenCalled();
  });

  it('allows a supervisor token (read-only oversight)', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'get', '/items/:itemId/conversions');
    const req = mockReq({ ...authHeader(generateSupervisorToken([BRANCH_1])), params: { itemId: 'item-1' } });
    const res = mockRes();
    vi.mocked(universalInventoryService.listItemConversions).mockResolvedValue([]);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.listItemConversions).toHaveBeenCalledWith('item-1');
  });
});

describe('POST /api/universal-inventory/items/:itemId/conversions', () => {
  it('rejects a supervisor token — identity mutation is Super Admin only', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items/:itemId/conversions');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      params: { itemId: 'item-1' },
      body: { from_unit_id: UNIT_1, to_unit_id: UNIT_1, factor: 7 },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.createItemConversion).not.toHaveBeenCalled();
  });

  it('forwards the create request to the service for a super_admin token', async () => {
    const TO_UNIT = randomUUID();
    const handlers = getRouteHandlers(universalInventoryRouter, 'post', '/items/:itemId/conversions');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      params: { itemId: 'item-1' },
      body: { from_unit_id: UNIT_1, to_unit_id: TO_UNIT, factor: 7 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.createItemConversion).mockResolvedValue({ id: 'conv-1' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(universalInventoryService.createItemConversion).toHaveBeenCalledWith(
      { inventoryItemId: 'item-1', fromUnitId: UNIT_1, toUnitId: TO_UNIT, factor: 7 },
      expect.any(Object),
      null,
    );
  });
});

describe('PATCH /api/universal-inventory/items/:itemId/conversions/:conversionId', () => {
  it('rejects a supervisor token', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'patch', '/items/:itemId/conversions/:conversionId');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      params: { itemId: 'item-1', conversionId: 'conv-1' },
      body: { factor: 9 },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.updateItemConversion).not.toHaveBeenCalled();
  });

  it('forwards the update to the service scoped to both itemId and conversionId', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'patch', '/items/:itemId/conversions/:conversionId');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      params: { itemId: 'item-1', conversionId: 'conv-1' },
      body: { factor: 9 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.updateItemConversion).mockResolvedValue({ id: 'conv-1', factor: 9 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.updateItemConversion).toHaveBeenCalledWith('item-1', 'conv-1', { factor: 9 }, expect.any(Object), null);
  });
});

describe('DELETE /api/universal-inventory/items/:itemId/conversions/:conversionId', () => {
  it('rejects a supervisor token', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'delete', '/items/:itemId/conversions/:conversionId');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      params: { itemId: 'item-1', conversionId: 'conv-1' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.deleteItemConversion).not.toHaveBeenCalled();
  });

  it('forwards the delete to the service scoped to both itemId and conversionId', async () => {
    const handlers = getRouteHandlers(universalInventoryRouter, 'delete', '/items/:itemId/conversions/:conversionId');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      params: { itemId: 'item-1', conversionId: 'conv-1' },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.deleteItemConversion).mockResolvedValue({ id: 'conv-1' });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.deleteItemConversion).toHaveBeenCalledWith('item-1', 'conv-1', expect.any(Object), null);
  });
});

describe('GET /:branchId/inventory-stock/movements — date filter boundary resolution', () => {
  it('widens a bare from_date/to_date filter to Manila day boundaries, not UTC midnight', async () => {
    const handlers = getRouteHandlers(inventoryStockBranchRouter, 'get', '/:branchId/inventory-stock/movements');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      params: { branchId: BRANCH_1 },
      query: { from_date: '2026-07-30', to_date: '2026-07-30' },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.getStockMovements).mockResolvedValue({ movements: [], total: 0, page: 1, limit: 25 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.getStockMovements).toHaveBeenCalledWith(
      BRANCH_1,
      expect.objectContaining({
        fromDate: new Date('2026-07-29T16:00:00.000Z'),
        toDate: new Date('2026-07-30T15:59:59.999Z'),
      }),
    );
  });

  it('accepts an already-precise ISO datetime for from_date/to_date and passes it through unchanged', async () => {
    const handlers = getRouteHandlers(inventoryStockBranchRouter, 'get', '/:branchId/inventory-stock/movements');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      params: { branchId: BRANCH_1 },
      query: { from_date: '2026-07-30T00:00:00.000Z', to_date: '2026-07-30T09:30:00.000Z' },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.getStockMovements).mockResolvedValue({ movements: [], total: 0, page: 1, limit: 25 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(universalInventoryService.getStockMovements).toHaveBeenCalledWith(
      BRANCH_1,
      expect.objectContaining({
        fromDate: new Date('2026-07-30T00:00:00.000Z'),
        toDate: new Date('2026-07-30T09:30:00.000Z'),
      }),
    );
  });
});

/**
 * Transfer RBAC policy — source-branch authorization. This is enforced by
 * branchGuard against the route's :branchId param (the source, always
 * req.params.branchId not the request body) *before* the service layer is
 * ever reached — a branch account cannot spoof its source branch, and a
 * supervisor cannot use a branch they aren't actively assigned to as a
 * source. Destination-branch authorization is a separate check that lives
 * in the service (universal-inventory.service.test.ts), since to_branch_id
 * is a body field with no equivalent route-level guard.
 */
describe('POST /:branchId/inventory-stock/transfer — source-branch authorization (branchGuard)', () => {
  it('branch account transferring from its own branch reaches the service', async () => {
    const handlers = getRouteHandlers(inventoryStockBranchRouter, 'post', '/:branchId/inventory-stock/transfer');
    const req = mockReq({
      ...authHeader(generateBranchToken(BRANCH_1)),
      params: { branchId: BRANCH_1 },
      body: { inventory_item_id: randomUUID(), to_branch_id: BRANCH_2, quantity: 5 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.transferStock).mockResolvedValue({} as never);

    await runHandlers(handlers, req, res);

    expect(universalInventoryService.transferStock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('branch account spoofing a different source branch than its own JWT is rejected before the service runs', async () => {
    const handlers = getRouteHandlers(inventoryStockBranchRouter, 'post', '/:branchId/inventory-stock/transfer');
    const req = mockReq({
      ...authHeader(generateBranchToken(BRANCH_1)),
      params: { branchId: BRANCH_2 },
      body: { inventory_item_id: randomUUID(), to_branch_id: BRANCH_1, quantity: 5 },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.transferStock).not.toHaveBeenCalled();
  });

  it('supervisor using an unassigned branch as the source is rejected before the service runs', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([BRANCH_1]);
    const handlers = getRouteHandlers(inventoryStockBranchRouter, 'post', '/:branchId/inventory-stock/transfer');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([BRANCH_1])),
      params: { branchId: BRANCH_2 },
      body: { inventory_item_id: randomUUID(), to_branch_id: BRANCH_1, quantity: 5 },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(universalInventoryService.transferStock).not.toHaveBeenCalled();
  });
});

describe('GET /:branchId/inventory-stock/transfer-destinations', () => {
  it('returns the backend-authorized destination list for the requesting actor', async () => {
    const handlers = getRouteHandlers(inventoryStockBranchRouter, 'get', '/:branchId/inventory-stock/transfer-destinations');
    const req = mockReq({
      ...authHeader(generateBranchToken(BRANCH_1)),
      params: { branchId: BRANCH_1 },
    });
    const res = mockRes();
    vi.mocked(universalInventoryService.getTransferDestinations).mockResolvedValue({
      branches: [{ id: BRANCH_2, name: 'Branch Two', code: 'MNL002' }],
    } as never);

    await runHandlers(handlers, req, res);

    expect(universalInventoryService.getTransferDestinations).toHaveBeenCalledWith(BRANCH_1, expect.objectContaining({ role: 'branch' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
