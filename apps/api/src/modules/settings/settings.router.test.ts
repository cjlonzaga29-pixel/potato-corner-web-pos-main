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
    updateDiscountPolicy: vi.fn(),
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
    vi.mocked(settingsService.getDiscountPolicy).mockResolvedValue(DEFAULT_POLICY as never);
    const handlers = getRouteHandlers(settingsRouter, 'get', '/discount-policy');
    const req = mockReq(authHeader(makeToken()));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(settingsService.getDiscountPolicy).toHaveBeenCalled();
  });

  it('an unauthenticated request (no Bearer token) gets 401, never reaches the service', async () => {
    const handlers = getRouteHandlers(settingsRouter, 'get', '/discount-policy');
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(settingsService.getDiscountPolicy).not.toHaveBeenCalled();
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
