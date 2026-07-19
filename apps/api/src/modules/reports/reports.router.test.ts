// apps/api/src/modules/reports/reports.router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

vi.mock('./reports.service.js', () => ({
  reportsService: {
    getDailySalesReport: vi.fn(),
    getShiftSummaryReport: vi.fn(),
    getCashReconciliationReport: vi.fn(),
    getVoidRefundReport: vi.fn(),
    getDiscountComplianceReport: vi.fn(),
    getInventoryMovementReport: vi.fn(),
    getAttendanceSummaryReport: vi.fn(),
    getFraudAlertSummaryReport: vi.fn(),
    getProductPerformanceReport: vi.fn(),
    getFlavorPerformanceReport: vi.fn(),
    getEmployeePerformanceReport: vi.fn(),
    getInventoryValuationReport: vi.fn(),
    getBranchComparisonReport: vi.fn(),
    requestExport: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

const { reportsService } = await import('./reports.service.js');
const { reportsRouter } = await import('./reports.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');
const { ReportError } = await import('./reports.types.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/reports/test', ...overrides } as unknown as Request;
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
});

describe('reports routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'get', path: '/daily-sales' },
    { method: 'get', path: '/shift-summary' },
    { method: 'get', path: '/cash-reconciliation' },
    { method: 'get', path: '/void-refund' },
    { method: 'get', path: '/discount-compliance' },
    { method: 'get', path: '/inventory-movement' },
    { method: 'get', path: '/attendance-summary' },
    { method: 'get', path: '/fraud-alert-summary' },
    { method: 'get', path: '/product-performance' },
    { method: 'get', path: '/flavor-performance' },
    { method: 'get', path: '/employee-performance' },
    { method: 'get', path: '/inventory-valuation' },
    { method: 'get', path: '/branch-comparison' },
    { method: 'post', path: '/export' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(reportsRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('GET /fraud-alert-summary — role guard', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/fraud-alert-summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reportsService.getFraudAlertSummaryReport).not.toHaveBeenCalled();
  });

  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/fraud-alert-summary');
    const token = generateSuperAdminToken();
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(reportsService.getFraudAlertSummaryReport).mockResolvedValue({ report_type: 'FRAUD_ALERT_SUMMARY', data: [] } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /branch-comparison — role guard', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/branch-comparison');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reportsService.getBranchComparisonReport).not.toHaveBeenCalled();
  });
});

describe('GET /daily-sales', () => {
  it('returns 200 for supervisor with valid filters', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/daily-sales');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1, date_from: '2026-07-01', date_to: '2026-07-15' } });
    const res = mockRes();
    vi.mocked(reportsService.getDailySalesReport).mockResolvedValue({ report_type: 'DAILY_SALES', data: [] } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(reportsService.getDailySalesReport).toHaveBeenCalled();
  });

  it('returns 422 when date_from is not a valid date string', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/daily-sales');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1, date_from: 'not-a-date' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(reportsService.getDailySalesReport).not.toHaveBeenCalled();
  });

  it('returns 403 for a staff member requesting a branch outside their assignment', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/daily-sales');
    const token = generateStaffToken(randomUUID());
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('GET /product-performance', () => {
  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'get', '/product-performance');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(reportsService.getProductPerformanceReport).mockResolvedValue({ report_type: 'PRODUCT_PERFORMANCE', data: [] } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /export', () => {
  it('returns 422 when report_type is missing', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { filters: { branch_id: BRANCH_1, page: 1, limit: 25 }, format: 'csv' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(reportsService.requestExport).not.toHaveBeenCalled();
  });

  it('returns 422 when format is missing', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { report_type: 'DAILY_SALES', filters: { branch_id: BRANCH_1, page: 1, limit: 25 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('returns 200 for a valid supervisor export request', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({
      ...authHeader(token),
      body: { report_type: 'DAILY_SALES', filters: { branch_id: BRANCH_1, page: 1, limit: 25 }, format: 'csv' },
    });
    const res = mockRes();
    vi.mocked(reportsService.requestExport).mockResolvedValue({ download_url: 'https://signed.example/x.csv', expires_at: '2026-07-17T00:00:00.000Z' });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(reportsService.requestExport).toHaveBeenCalledWith('DAILY_SALES', expect.any(Object), 'csv', expect.any(String), 'supervisor', BRANCH_1);
  });

  it('propagates a 403 ReportError from the service (super-admin-only report type)', async () => {
    const handlers = getRouteHandlers(reportsRouter, 'post', '/export');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({
      ...authHeader(token),
      body: { report_type: 'BRANCH_COMPARISON', filters: { page: 1, limit: 25 }, format: 'csv' },
    });
    const res = mockRes();
    vi.mocked(reportsService.requestExport).mockRejectedValue(new ReportError('FORBIDDEN_REPORT_TYPE', 'not allowed', 403));

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
