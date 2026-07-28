import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/** Same technique as product-components.router.test.ts: run the real middleware chain against mock req/res, service layer mocked. */
vi.mock('./shadow-bom-deduction.service.js', () => ({
  shadowBomDeductionService: {
    getSummary: vi.fn(),
    getDetails: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { shadowBomDeductionService } = await import('./shadow-bom-deduction.service.js');
const { shadowBomDeductionRouter } = await import('./shadow-bom-deduction.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/shadow-bom-deduction/test', ...overrides } as unknown as Request;
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('GET /summary — admin-only', () => {
  it('allows super_admin and returns the summary shape', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/summary');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token) });
    const res = mockRes();
    vi.mocked(shadowBomDeductionService.getSummary).mockResolvedValue({
      total: 10,
      matchCount: 8,
      matchPercentage: 80,
      countsByClassification: { MATCH: 8, QUANTITY_MISMATCH: 2 },
      affectedProductVariantIds: ['variant-1'],
      affectedBranchIds: ['branch-1'],
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ total_compared: 10, match_count: 8, match_percentage: 80 }),
      }),
    );
  });

  it('rejects supervisor with 403 (admin-only, unlike recipe-readiness which is admin-or-supervisor)', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(shadowBomDeductionService.getSummary).not.toHaveBeenCalled();
  });

  it('rejects branch-role callers with 403', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/summary');
    const token = generateBranchToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(shadowBomDeductionService.getSummary).not.toHaveBeenCalled();
  });

  it('rejects an invalid classification filter with 422 VALIDATION_ERROR', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/summary');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { classification: 'NOT_A_REAL_CLASSIFICATION' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(shadowBomDeductionService.getSummary).not.toHaveBeenCalled();
  });

  it('narrows results by branch_id filter', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/summary');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(shadowBomDeductionService.getSummary).mockResolvedValue({
      total: 1,
      matchCount: 1,
      matchPercentage: 100,
      countsByClassification: { MATCH: 1 },
      affectedProductVariantIds: [],
      affectedBranchIds: [],
    });

    await runHandlers(handlers, req, res);

    expect(shadowBomDeductionService.getSummary).toHaveBeenCalledWith(expect.objectContaining({ branchId: BRANCH_1 }));
  });
});

describe('GET /details — admin-only', () => {
  it('allows super_admin and returns a paginated list', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/details');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { page: '2', page_size: '10' } });
    const res = mockRes();
    vi.mocked(shadowBomDeductionService.getDetails).mockResolvedValue({
      rows: [
        {
          id: 'row-1',
          transactionId: 'txn-1',
          saleLineId: 'line-1',
          branchId: BRANCH_1,
          productVariantId: 'variant-1',
          legacyCalculation: [],
          bomCalculation: [],
          classification: 'MATCH',
          errorDetails: null,
          comparedAt: new Date('2026-07-28T00:00:00.000Z'),
        },
      ] as never,
      total: 11,
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(shadowBomDeductionService.getDetails).toHaveBeenCalledWith(expect.any(Object), 2, 10);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ page: 2, page_size: 10, total: 11 }) }),
    );
  });

  it('rejects supervisor with 403', async () => {
    const handlers = getRouteHandlers(shadowBomDeductionRouter, 'get', '/details');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(shadowBomDeductionService.getDetails).not.toHaveBeenCalled();
  });
});
