import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Fast-release regressions #3/#4 — GET/PUT /api/settings/discount-policy
 * authorization. Same no-supertest technique as transactions.router.test.ts:
 * pull the real middleware chain (authenticate, authorize guard,
 * requirePasswordChange) straight off the Router instance and run it
 * against mock req/res, with only the service layer and authenticate's
 * prisma.revokedToken lookup mocked.
 */
vi.mock('./settings.service.js', () => ({
  settingsService: {
    getDiscountPolicy: vi.fn(),
    getDiscountPolicyFor: vi.fn(),
    updateDiscountPolicy: vi.fn(),
    getTaxConfiguration: vi.fn(),
    getWorkHoursPolicy: vi.fn(),
    updateWorkHoursPolicy: vi.fn(),
    getWriteGate: vi.fn(),
    setWriteGate: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    revokedToken: { findFirst: vi.fn() },
  },
}));

const { settingsService } = await import('./settings.service.js');
const { settingsRouter } = await import('./settings.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken, generateBranchToken } = await import(
  '../../test-utils/auth-tokens.js'
);

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/settings/discount-policy', ...overrides } as unknown as Request;
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

const DEFAULT_POLICY = {
  pwd: { percentage: 20, isEnabled: true },
  senior_citizen: { percentage: 20, isEnabled: true },
  employee: { percentage: 20, isEnabled: true },
  promotional: { percentage: 20, isEnabled: true },
  updatedAt: null,
  updatedBy: null,
};

describe('GET /discount-policy — all roles may read (Cashier/Staff and Branch Account are READ ONLY)', () => {
  it.each([
    ['super_admin', () => generateSuperAdminToken()],
    ['supervisor', () => generateSupervisorToken([BRANCH_1])],
    ['staff', () => generateStaffToken(BRANCH_1)],
    ['branch account', () => generateBranchToken(BRANCH_1)],
  ])('%s can GET the discount policy — 200', async (_label, makeToken) => {
    vi.mocked(settingsService.getDiscountPolicyFor).mockResolvedValue(DEFAULT_POLICY as never);
    const handlers = getRouteHandlers(settingsRouter, 'get', '/discount-policy');
    const req = mockReq(authHeader(makeToken()));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // POS-PERF-P50R — the service scopes staff/branch callers to their own branch.
    expect(settingsService.getDiscountPolicyFor).toHaveBeenCalledWith(expect.objectContaining({ user_id: expect.any(String) }), undefined);
  });

  it('POS-PERF-P50R: a malformed ?branch_id= is a 400 and never reaches the service', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'get', '/discount-policy');
    const req = mockReq({ ...authHeader(generateSupervisorToken([BRANCH_1])), query: { branch_id: 'not-a-uuid' } as never });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsService.getDiscountPolicyFor).not.toHaveBeenCalled();
  });

  it('an unauthenticated request (no Bearer token) gets 401, never reaches the service', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'get', '/discount-policy');
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(settingsService.getDiscountPolicyFor).not.toHaveBeenCalled();
  });
});

describe('PUT /discount-policy — only Supervisor/Super Admin may write (Cashier/Staff and Branch Account are READ ONLY)', () => {
  it('staff cannot update the discount policy — 403, service never reached', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/discount-policy');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: { pwd: { percentage: 10 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.updateDiscountPolicy).not.toHaveBeenCalled();
  });

  it('a branch account cannot update the discount policy — 403, service never reached', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/discount-policy');
    const token = generateBranchToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: { pwd: { percentage: 10 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.updateDiscountPolicy).not.toHaveBeenCalled();
  });

  it('a supervisor can update the discount policy — 200', async () => {
    vi.mocked(settingsService.updateDiscountPolicy).mockResolvedValue({ ...DEFAULT_POLICY, pwd: { percentage: 10, isEnabled: true } } as never);
    const handlers = getRouteHandlers(settingsRouter, 'put', '/discount-policy');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { pwd: { percentage: 10 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.updateDiscountPolicy).toHaveBeenCalled();
  });

  it('a super admin can update the discount policy — 200', async () => {
    vi.mocked(settingsService.updateDiscountPolicy).mockResolvedValue({ ...DEFAULT_POLICY, pwd: { percentage: 15, isEnabled: true } } as never);
    const handlers = getRouteHandlers(settingsRouter, 'put', '/discount-policy');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { pwd: { percentage: 15 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.updateDiscountPolicy).toHaveBeenCalled();
  });

  it('an out-of-range percentage is rejected by validate() before reaching the service — 422', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/discount-policy');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { pwd: { percentage: 150 } } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(settingsService.updateDiscountPolicy).not.toHaveBeenCalled();
  });
});

const DEFAULT_WORK_HOURS_POLICY = { regularHours: 8, updatedAt: null, updatedBy: null };

// P3D-P4 — GET/PUT /api/settings/work-hours authorization. Same
// no-supertest technique as discount-policy above.
describe('GET /work-hours — all roles may read', () => {
  it.each([
    ['super_admin', () => generateSuperAdminToken()],
    ['supervisor', () => generateSupervisorToken([BRANCH_1])],
    ['staff', () => generateStaffToken(BRANCH_1)],
    ['branch account', () => generateBranchToken(BRANCH_1)],
  ])('%s can GET the work hours policy — 200', async (_label, makeToken) => {
    vi.mocked(settingsService.getWorkHoursPolicy).mockResolvedValue(DEFAULT_WORK_HOURS_POLICY as never);
    const handlers = getRouteHandlers(settingsRouter, 'get', '/work-hours');
    const req = mockReq(authHeader(makeToken()));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.getWorkHoursPolicy).toHaveBeenCalled();
  });

  it('an unauthenticated request (no Bearer token) gets 401, never reaches the service', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'get', '/work-hours');
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(settingsService.getWorkHoursPolicy).not.toHaveBeenCalled();
  });
});

describe('PUT /work-hours — only Super Admin may write', () => {
  it('staff cannot update the work hours policy — 403, service never reached', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/work-hours');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: { regularHours: 9 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.updateWorkHoursPolicy).not.toHaveBeenCalled();
  });

  it('a branch account cannot update the work hours policy — 403, service never reached', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/work-hours');
    const token = generateBranchToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: { regularHours: 9 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.updateWorkHoursPolicy).not.toHaveBeenCalled();
  });

  it('a supervisor cannot update the work hours policy — 403, service never reached (unlike discount-policy, this is adminOnly)', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/work-hours');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { regularHours: 9 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.updateWorkHoursPolicy).not.toHaveBeenCalled();
  });

  it('a super admin can update the work hours policy — 200', async () => {
    vi.mocked(settingsService.updateWorkHoursPolicy).mockResolvedValue({ regularHours: 9, updatedAt: new Date().toISOString(), updatedBy: 'admin-1' } as never);
    const handlers = getRouteHandlers(settingsRouter, 'put', '/work-hours');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { regularHours: 9 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.updateWorkHoursPolicy).toHaveBeenCalled();
  });

  it.each([[0], [-1], [25], [Number.NaN]])(
    'an invalid regularHours value (%s) is rejected by validate() before reaching the service — 422',
    async (regularHours) => {
      const handlers = getRouteHandlers(settingsRouter, 'put', '/work-hours');
      const token = generateSuperAdminToken();
      const req = mockReq({ ...authHeader(token), body: { regularHours } });
      const res = mockRes();

      await runHandlers(handlers, req, res);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(settingsService.updateWorkHoursPolicy).not.toHaveBeenCalled();
    },
  );
});

// POS-PERF-P16 — GET/PUT /api/settings/write-gate authorization. Same
// no-supertest technique as work-hours above: adminOnly on both verbs
// (narrower than discount-policy's adminOrSupervisor), since this lever
// blocks checkout/inventory writes for every branch at once.
describe('GET /write-gate — only Super Admin may read', () => {
  it.each([
    ['supervisor', () => generateSupervisorToken([BRANCH_1])],
    ['staff', () => generateStaffToken(BRANCH_1)],
    ['branch account', () => generateBranchToken(BRANCH_1)],
  ])('%s cannot GET the write gate state — 403, service never reached', async (_label, makeToken) => {
    const handlers = getRouteHandlers(settingsRouter, 'get', '/write-gate');
    const req = mockReq(authHeader(makeToken()));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.getWriteGate).not.toHaveBeenCalled();
  });

  it('an unauthenticated request (no Bearer token) gets 401, never reaches the service', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'get', '/write-gate');
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(settingsService.getWriteGate).not.toHaveBeenCalled();
  });

  it('a super admin can GET the write gate state — 200', async () => {
    vi.mocked(settingsService.getWriteGate).mockResolvedValue({
      enabled: false,
      reason: null,
      updatedAt: null,
      updatedBy: null,
      activeGatedRequests: 0,
    } as never);
    const handlers = getRouteHandlers(settingsRouter, 'get', '/write-gate');
    const req = mockReq(authHeader(generateSuperAdminToken()));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.getWriteGate).toHaveBeenCalled();
  });
});

describe('PUT /write-gate — only Super Admin may write, no public/unauthenticated path exists', () => {
  it.each([
    ['supervisor', () => generateSupervisorToken([BRANCH_1])],
    ['staff', () => generateStaffToken(BRANCH_1)],
    ['branch account', () => generateBranchToken(BRANCH_1)],
  ])('%s cannot toggle the write gate — 403, service never reached', async (_label, makeToken) => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/write-gate');
    const req = mockReq({ ...authHeader(makeToken()), body: { enabled: true, reason: 'release' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsService.setWriteGate).not.toHaveBeenCalled();
  });

  it('an unauthenticated request (no Bearer token) gets 401, never reaches the service', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/write-gate');
    const req = mockReq({ body: { enabled: true, reason: 'release' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(settingsService.setWriteGate).not.toHaveBeenCalled();
  });

  it('a super admin can close the gate with a reason — 200', async () => {
    vi.mocked(settingsService.setWriteGate).mockResolvedValue({
      enabled: true,
      reason: 'release swap',
      updatedAt: new Date().toISOString(),
      updatedBy: 'admin-1',
      activeGatedRequests: 0,
    } as never);
    const handlers = getRouteHandlers(settingsRouter, 'put', '/write-gate');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { enabled: true, reason: 'release swap' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.setWriteGate).toHaveBeenCalled();
  });

  it('closing the gate without a reason is rejected by validate() before reaching the service — 422', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'put', '/write-gate');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { enabled: true } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(settingsService.setWriteGate).not.toHaveBeenCalled();
  });

  it('a super admin can reopen the gate with no reason — 200', async () => {
    vi.mocked(settingsService.setWriteGate).mockResolvedValue({
      enabled: false,
      reason: null,
      updatedAt: new Date().toISOString(),
      updatedBy: 'admin-1',
      activeGatedRequests: 0,
    } as never);
    const handlers = getRouteHandlers(settingsRouter, 'put', '/write-gate');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), body: { enabled: false } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.setWriteGate).toHaveBeenCalled();
  });
});

// POS-PERF-P50 — read-only tax configuration and the two new settings refusals.
describe('GET /tax — every role may read; there is no write route', () => {
  it.each([
    ['super_admin', () => generateSuperAdminToken()],
    ['supervisor', () => generateSupervisorToken([BRANCH_1])],
    ['staff', () => generateStaffToken(BRANCH_1)],
    ['branch account', () => generateBranchToken(BRANCH_1)],
  ])('%s can GET the tax configuration — 200', async (_label, makeToken) => {
    vi.mocked(settingsService.getTaxConfiguration).mockResolvedValue({ vatRatePercent: 12 } as never);
    const res = mockRes();
    await runHandlers(getRouteHandlers(settingsRouter, 'get', '/tax'), mockReq(authHeader(makeToken())), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('unauthenticated — 401, service never reached', async () => {
    const res = mockRes();
    await runHandlers(getRouteHandlers(settingsRouter, 'get', '/tax'), mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(settingsService.getTaxConfiguration).not.toHaveBeenCalled();
  });

  it.each(['put', 'post', 'patch', 'delete'])('no %s route exists for /tax', (method) => {
    expect(() => getRouteHandlers(settingsRouter, method, '/tax')).toThrow(/No route registered/);
  });
});

describe('PUT /discount-policy — P50 refusals reach the client with their status and details', () => {
  it.each([
    ['STATUTORY_DISCOUNT_LOCKED', 422, undefined],
    ['SETTINGS_CHANGED', 409, { current: { employee: { percentage: 30, isEnabled: true } } }],
  ])('%s -> %i', async (code, status, details) => {
    const { SettingsError } = await import('./settings.types.js');
    vi.mocked(settingsService.updateDiscountPolicy).mockRejectedValue(new SettingsError(code, 'refused', status, details));
    const res = mockRes() as Response & { jsonBody?: unknown };
    await runHandlers(
      getRouteHandlers(settingsRouter, 'put', '/discount-policy'),
      mockReq({ ...authHeader(generateSupervisorToken([BRANCH_1])), body: { employee: { percentage: 10 }, expectedUpdatedAt: '2026-10-01T00:00:00.000Z' } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.jsonBody).toMatchObject({ error: { code, ...(details ? { details } : {}) } });
  });

  it('an expectedUpdatedAt that is not an ISO datetime is rejected by validate() — 422', async () => {
    const res = mockRes();
    await runHandlers(
      getRouteHandlers(settingsRouter, 'put', '/discount-policy'),
      mockReq({ ...authHeader(generateSuperAdminToken()), body: { employee: { percentage: 10 }, expectedUpdatedAt: 'yesterday' } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(422);
    expect(settingsService.updateDiscountPolicy).not.toHaveBeenCalled();
  });
});
