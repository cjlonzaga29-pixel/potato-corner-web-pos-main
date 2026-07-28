import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

vi.mock('./recipe-readiness.service.js', () => ({
  recipeReadinessService: {
    buildReport: vi.fn(),
  },
}));

vi.mock('../../lib/branch-access.js', () => ({
  getAccessibleBranchIds: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { recipeReadinessService } = await import('./recipe-readiness.service.js');
const { getAccessibleBranchIds } = await import('../../lib/branch-access.js');
const { recipeReadinessRouter } = await import('./recipe-readiness.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateBranchToken, generateStaffToken } = await import(
  '../../test-utils/auth-tokens.js'
);

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/recipe-readiness/test', ...overrides } as unknown as Request;
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

const EMPTY_REPORT = {
  generatedAt: new Date('2026-07-28T00:00:00.000Z'),
  summary: {
    totalVariants: 0,
    readyCount: 0,
    blockedCount: 0,
    readinessPercentage: 0,
    countsByStatus: {
      READY: 0,
      NO_RECIPE: 0,
      INVALID_COMPONENT: 0,
      UNRESOLVED_MAPPING: 0,
      INCOMPLETE_BRANCH_STOCK: 0,
      BACKFILL_CONFLICT: 0,
      LEGACY_FLAVOR_DEPENDENCY: 0,
      INACTIVE: 0,
    },
  },
  variants: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
  vi.mocked(recipeReadinessService.buildReport).mockResolvedValue(EMPTY_REPORT as never);
  vi.mocked(getAccessibleBranchIds).mockResolvedValue('all');
});

describe('GET /api/recipe-readiness — Admin and Supervisor read access', () => {
  it('allows super_admin to fetch the report', async () => {
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq(authHeader(generateSuperAdminToken()));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(recipeReadinessService.buildReport).toHaveBeenCalledWith(expect.objectContaining({ accessibleBranchIds: 'all' }));
  });

  it('allows supervisor to fetch the report, scoped to their accessible (org-wide active) branches', async () => {
    vi.mocked(getAccessibleBranchIds).mockResolvedValue([BRANCH_1, BRANCH_2]);
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq(authHeader(generateSupervisorToken([BRANCH_1])));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(recipeReadinessService.buildReport).toHaveBeenCalledWith(expect.objectContaining({ accessibleBranchIds: [BRANCH_1, BRANCH_2] }));
  });

  it('rejects branch-role callers with 403', async () => {
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq(authHeader(generateBranchToken(BRANCH_1)));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(recipeReadinessService.buildReport).not.toHaveBeenCalled();
  });

  it('rejects staff-role callers with 403', async () => {
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq(authHeader(generateStaffToken(BRANCH_1)));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(recipeReadinessService.buildReport).not.toHaveBeenCalled();
  });

  it('rejects a supervisor requesting a branch_id outside their accessible set with 403 BRANCH_ACCESS_DENIED', async () => {
    vi.mocked(getAccessibleBranchIds).mockResolvedValue([BRANCH_1]);
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateSupervisorToken([BRANCH_1])), query: { branch_id: BRANCH_2 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }) }));
    expect(recipeReadinessService.buildReport).not.toHaveBeenCalled();
  });

  it('rejects an invalid query with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), query: { status: 'NOT_A_REAL_STATUS' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(recipeReadinessService.buildReport).not.toHaveBeenCalled();
  });

  it('passes filters through and returns a snake_case response envelope', async () => {
    vi.mocked(recipeReadinessService.buildReport).mockResolvedValue({
      generatedAt: new Date('2026-07-28T00:00:00.000Z'),
      summary: EMPTY_REPORT.summary,
      variants: [
        {
          productId: 'p1',
          productName: 'Fries',
          productVariantId: 'v1',
          variantName: 'Regular',
          sizeLabel: 'Regular',
          status: 'READY',
          blockers: [],
          affectedBranchIds: [],
          affectedInventoryItemIds: [],
          availableBranchIds: [BRANCH_1],
        },
      ],
    } as never);
    const handlers = getRouteHandlers(recipeReadinessRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), query: { status: 'READY' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(recipeReadinessService.buildReport).toHaveBeenCalledWith(expect.objectContaining({ status: 'READY' }));
    const body = (res as unknown as { jsonBody: { data: { variants: Array<Record<string, unknown>> } } }).jsonBody;
    expect(body.data.variants[0]).toMatchObject({ product_variant_id: 'v1', available_branch_ids: [BRANCH_1] });
  });
});
