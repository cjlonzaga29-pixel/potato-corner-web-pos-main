import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P52 — payroll routes through the real middleware chain
 * (authenticate, adminOrSupervisor, requirePasswordChange, branchGuard,
 * validate) with only the service mocked. Same technique as
 * attendance.router.test.ts.
 */
vi.mock('./payroll.service.js', () => ({
  payrollService: {
    getSettings: vi.fn(),
    savePolicy: vi.fn(),
    listRates: vi.fn(),
    createRate: vi.fn(),
    voidRate: vi.fn(),
    listPeriods: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    addAdjustment: vi.fn(),
    voidAdjustment: vi.fn(),
    addResolution: vi.fn(),
    finalize: vi.fn(),
    discard: vi.fn(),
    revise: vi.fn(),
    markPaid: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    revokedToken: { findFirst: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ status: 'active', isActive: true }) },
  },
}));

vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: { findAllActiveBranchIds: vi.fn() },
}));

vi.mock('../../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn() }));

const { prisma } = await import('../../lib/prisma.js');
const { payrollService } = await import('./payroll.service.js');
const { payrollRouter } = await import('./payroll.router.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken, generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
interface MockRes {
  statusCode: number;
  jsonBody?: unknown;
  sent?: unknown;
  headers: Record<string, string>;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/payroll/test', ...overrides } as unknown as Request;
}

/** A recording stand-in for Express's Response; cast where the handlers need a Response. */
function mockRes(): MockRes & Record<string, unknown> {
  const res: MockRes & Record<string, unknown> = { statusCode: 200, headers: {} };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  });
  res.send = vi.fn((body: unknown) => {
    res.sent = body;
    return res;
  });
  res.setHeader = vi.fn((name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  });
  return res;
}

function getRouteHandlers(router: Router, method: string, path: string): Middleware[] {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Middleware }> } };
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function run(method: string, path: string, req: Request): Promise<MockRes> {
  const res = mockRes();
  for (const handler of getRouteHandlers(payrollRouter, method, path)) {
    let calledNext = false;
    await handler(req, res as unknown as Response, (() => {
      calledNext = true;
    }) as NextFunction);
    if (!calledNext) break;
  }
  return res;
}

const BRANCH_1 = randomUUID();
const BRANCH_2 = randomUUID();
const RUN_1 = randomUUID();
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'get', path: '/branches/:branchId/settings' },
  { method: 'put', path: '/branches/:branchId/policy' },
  { method: 'get', path: '/branches/:branchId/rates' },
  { method: 'post', path: '/branches/:branchId/rates' },
  { method: 'post', path: '/branches/:branchId/rates/:rateId/void' },
  { method: 'get', path: '/branches/:branchId/periods' },
  { method: 'post', path: '/branches/:branchId/runs' },
  { method: 'get', path: '/branches/:branchId/runs/:runId' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/adjustments' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/adjustments/:adjustmentId/void' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/resolutions' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/finalize' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/discard' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/revise' },
  { method: 'post', path: '/branches/:branchId/runs/:runId/mark-paid' },
  { method: 'get', path: '/branches/:branchId/runs/:runId/export' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([BRANCH_1]);
});

describe('payroll routes — who may call them', () => {
  it.each(ROUTES)('$method $path: 401 without a token', async ({ method, path }) => {
    const res = await run(method, path, mockReq({ params: { branchId: BRANCH_1 } }));
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)('$method $path: 403 for a Branch Account and for staff', async ({ method, path }) => {
    for (const token of [generateBranchToken(BRANCH_1), generateStaffToken(BRANCH_1)]) {
      const res = await run(method, path, mockReq({ ...auth(token), params: { branchId: BRANCH_1, runId: RUN_1 } }));
      expect(res.statusCode).toBe(403);
    }
    expect(Object.values(payrollService).every((fn) => vi.mocked(fn).mock.calls.length === 0)).toBe(true);
  });

  it.each(ROUTES)('$method $path: 403 for a supervisor outside their active branches, whatever the JWT claims', async ({ method, path }) => {
    const token = generateSupervisorToken([BRANCH_1, BRANCH_2]); // stale claim; DB says BRANCH_1 only
    const res = await run(method, path, mockReq({ ...auth(token), params: { branchId: BRANCH_2, runId: RUN_1 } }));
    expect(res.statusCode).toBe(403);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('BRANCH_ACCESS_DENIED');
  });

  it('lets a supervisor read their own branch and Super Admin any branch', async () => {
    vi.mocked(payrollService.getSettings).mockResolvedValue({ policy: null } as never);
    const sup = await run('get', '/branches/:branchId/settings', mockReq({ ...auth(generateSupervisorToken([BRANCH_1])), params: { branchId: BRANCH_1 } }));
    expect(sup.statusCode).toBe(200);
    const admin = await run('get', '/branches/:branchId/settings', mockReq({ ...auth(generateSuperAdminToken()), params: { branchId: BRANCH_2 } }));
    expect(admin.statusCode).toBe(200);
    expect(payrollService.getSettings).toHaveBeenCalledTimes(2);
  });
});

describe('payroll routes — validation', () => {
  const supToken = () => generateSupervisorToken([BRANCH_1]);

  it('refuses a policy without an explicit break treatment or with an inconsistent cutoff', async () => {
    const res = await run(
      'put',
      '/branches/:branchId/policy',
      mockReq({ ...auth(supToken()), params: { branchId: BRANCH_1 }, body: { timezone: 'Asia/Manila', period_type: 'semi_monthly', expected_version: 0 } }),
    );
    expect(res.statusCode).toBe(422);
    expect(payrollService.savePolicy).not.toHaveBeenCalled();
  });

  it('refuses a deduction without documentation, and non-2-decimal or zero-less amounts', async () => {
    const base = { employee_id: randomUUID(), kind: 'deduction', category: 'documented_deduction', amount: '50', reason: 'Shortage' };
    const noDoc = await run('post', '/branches/:branchId/runs/:runId/adjustments', mockReq({ ...auth(supToken()), params: { branchId: BRANCH_1, runId: RUN_1 }, body: base }));
    expect(noDoc.statusCode).toBe(422);
    const badAmount = await run(
      'post',
      '/branches/:branchId/runs/:runId/adjustments',
      mockReq({ ...auth(supToken()), params: { branchId: BRANCH_1, runId: RUN_1 }, body: { ...base, documentation_ref: 'Form 1', amount: '10.555' } }),
    );
    expect(badAmount.statusCode).toBe(422);
    const rate = await run(
      'post',
      '/branches/:branchId/rates',
      mockReq({ ...auth(supToken()), params: { branchId: BRANCH_1 }, body: { employee_id: randomUUID(), effective_from: '2026-10-01', hourly_rate: '-5', reason: 'x', expected_latest_rate_id: null } }),
    );
    expect(rate.statusCode).toBe(422);
    expect(payrollService.addAdjustment).not.toHaveBeenCalled();
    expect(payrollService.createRate).not.toHaveBeenCalled();
  });

  it('requires an explicit scope acknowledgement and a fingerprint to finalize', async () => {
    const res = await run(
      'post',
      '/branches/:branchId/runs/:runId/finalize',
      mockReq({ ...auth(supToken()), params: { branchId: BRANCH_1, runId: RUN_1 }, body: { expected_fingerprint: 'a'.repeat(64), acknowledge_scope: false } }),
    );
    expect(res.statusCode).toBe(422);
    expect(payrollService.finalize).not.toHaveBeenCalled();
  });

  it('passes the verified actor and URL branch to the service, never body ids', async () => {
    vi.mocked(payrollService.finalize).mockResolvedValue({ id: RUN_1 } as never);
    await run(
      'post',
      '/branches/:branchId/runs/:runId/finalize',
      mockReq({ ...auth(supToken()), params: { branchId: BRANCH_1, runId: RUN_1 }, body: { expected_fingerprint: 'a'.repeat(64), acknowledge_scope: true, branch_id: BRANCH_2 } }),
    );
    const [actor, branchId, runId] = vi.mocked(payrollService.finalize).mock.calls[0] ?? [];
    expect((actor as { role: string }).role).toBe('supervisor');
    expect(branchId).toBe(BRANCH_1);
    expect(runId).toBe(RUN_1);
  });
});

describe('payroll export route', () => {
  it('streams a CSV attachment built from the run detail, with no-store caching', async () => {
    vi.mocked(payrollService.getRun).mockResolvedValue({
      id: RUN_1,
      branch_id: BRANCH_1,
      branch_name: 'North',
      period_start: '2026-10-16',
      period_end: '2026-10-31',
      status: 'draft',
      revision_number: 1,
      calculated_at: '2026-10-30T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      policy: null,
      totals: { basic_pay: '0.00', earnings_adjustments: '0.00', deductions: '0.00', calculated_total: '0.00', payable_ms: 0 },
      employees: [],
      issues: [],
      exclusions: ['Withholding tax'],
      total_label: 'Calculated total (before statutory items)',
      employee_filter: null,
      finalized_by_name: null,
      paid_at: null,
    } as never);
    const res = await run(
      'get',
      '/branches/:branchId/runs/:runId/export',
      mockReq({ ...auth(generateSupervisorToken([BRANCH_1])), params: { branchId: BRANCH_1, runId: RUN_1 }, query: { format: 'csv' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('_DRAFT.csv');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.sent)).toContain('DRAFT — NOT FINALIZED');
  });

  it('rejects an unknown export format', async () => {
    const res = await run(
      'get',
      '/branches/:branchId/runs/:runId/export',
      mockReq({ ...auth(generateSupervisorToken([BRANCH_1])), params: { branchId: BRANCH_1, runId: RUN_1 }, query: { format: 'xlsx' } }),
    );
    expect(res.statusCode).toBe(422);
  });
});
