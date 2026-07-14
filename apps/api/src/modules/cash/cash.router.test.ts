import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as inventory.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate, authorize guards, branchGuard, requirePasswordChange,
 * validate) is pulled straight off the Router instance and run against
 * mock req/res objects, with only the service layer mocked.
 */
vi.mock('./cash.service.js', () => ({
  cashService: {
    openShift: vi.fn(),
    getCurrentShift: vi.fn(),
    getShiftById: vi.fn(),
    getShiftSummary: vi.fn(),
    listShifts: vi.fn(),
    closeShift: vi.fn(),
    approveVariance: vi.fn(),
    voidShift: vi.fn(),
  },
}));

vi.mock('../../lib/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

const { redis } = await import('../../lib/redis.js');
const { cashService } = await import('./cash.service.js');
const { cashRouter } = await import('./cash.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/cash/test', ...overrides } as unknown as Request;
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
const SHIFT_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(redis.get).mockResolvedValue(null);
});

describe('cash routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'post', path: '/open' },
    { method: 'get', path: '/current' },
    { method: 'get', path: '/' },
    { method: 'get', path: '/:shiftId' },
    { method: 'get', path: '/:shiftId/summary' },
    { method: 'post', path: '/:shiftId/close' },
    { method: 'post', path: '/:shiftId/approve-variance' },
    { method: 'post', path: '/:shiftId/void' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(cashRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('POST /open — role guard', () => {
  it('staff cannot open a shift — 403', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/open');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: { branch_id: BRANCH_1, cashier_id: randomUUID(), starting_cash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(cashService.openShift).not.toHaveBeenCalled();
  });

  it('rejects a body missing denominations with 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/open');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { branch_id: BRANCH_1, cashier_id: randomUUID(), starting_cash: 1000 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(cashService.openShift).not.toHaveBeenCalled();
  });

  it('a supervisor opening a shift for a branch they are not assigned to gets 403 from branchGuard', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/open');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { branch_id: BRANCH_2, cashier_id: randomUUID(), starting_cash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
    expect(cashService.openShift).not.toHaveBeenCalled();
  });
});

describe('POST /:shiftId/approve-variance — role guard', () => {
  it('supervisor cannot approve a variance — 403 (super_admin only)', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/:shiftId/approve-variance');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 }, body: { approved: true, notes: 'x'.repeat(50) } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(cashService.approveVariance).not.toHaveBeenCalled();
  });

  it('rejects a notes field under 50 characters with 422', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/:shiftId/approve-variance');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 }, body: { approved: true, notes: 'too short' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(cashService.approveVariance).not.toHaveBeenCalled();
  });

  it('super_admin can approve a variance', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/:shiftId/approve-variance');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 }, body: { approved: true, notes: 'x'.repeat(50) } });
    const res = mockRes();
    vi.mocked(cashService.approveVariance).mockResolvedValue({ id: SHIFT_1, status: 'closed' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(cashService.approveVariance).toHaveBeenCalled();
  });
});

describe('POST /:shiftId/void — role guard', () => {
  it('supervisor cannot void a shift — 403 (super_admin only)', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/:shiftId/void');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(cashService.voidShift).not.toHaveBeenCalled();
  });
});

describe('GET /:shiftId — branch protection (inline pattern, same as GET /ingredients/:id)', () => {
  it("blocks a supervisor from fetching another branch's shift — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftById).mockResolvedValue({ id: SHIFT_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('allows a supervisor to fetch a shift belonging to their own branch — 200', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftById).mockResolvedValue({ id: SHIFT_1, branch_id: BRANCH_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows a super_admin to fetch any shift regardless of branch — 200', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftById).mockResolvedValue({ id: SHIFT_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /current', () => {
  it('returns the active shift for a staff member requesting their own branch', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/current');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(cashService.getCurrentShift).mockResolvedValue({ id: SHIFT_1, branch_id: BRANCH_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('a staff member requesting a different branch gets 403 from branchGuard', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/current');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_2 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(cashService.getCurrentShift).not.toHaveBeenCalled();
  });

  it('a staff member with no branch_id in the query gets 400 BRANCH_ID_REQUIRED from branchGuard', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/current');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ID_REQUIRED' } }));
    expect(cashService.getCurrentShift).not.toHaveBeenCalled();
  });

  it('a super_admin with no branch_id in the query gets 400 BRANCH_ID_REQUIRED from the route handler (branchGuard bypasses super_admin)', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/current');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(cashService.getCurrentShift).not.toHaveBeenCalled();
  });
});

describe('GET /:shiftId/summary', () => {
  it('staff cannot fetch a shift summary — 403', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(cashService.getShiftSummary).not.toHaveBeenCalled();
  });

  it("blocks a supervisor from fetching another branch's shift summary — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftSummary).mockResolvedValue({ shift: { id: SHIFT_1, branch_id: BRANCH_2 }, summary: {} } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('allows a supervisor to fetch their own branch shift summary — 200', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftSummary).mockResolvedValue({ shift: { id: SHIFT_1, branch_id: BRANCH_1 }, summary: {} } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows a super_admin to fetch any branch shift summary — 200', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftSummary).mockResolvedValue({ shift: { id: SHIFT_1, branch_id: BRANCH_2 }, summary: {} } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /:shiftId/close — validate middleware', () => {
  it('rejects a body missing denominations with 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(cashRouter, 'post', '/:shiftId/close');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 }, body: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(cashService.closeShift).not.toHaveBeenCalled();
  });
});
