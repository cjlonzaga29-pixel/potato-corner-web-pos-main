import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ROLES } from '@potato-corner/shared';

/**
 * Task 122: the bug this suite guards against — select-employee used to
 * mint and cookie an employee refresh token, so a hard refresh's silent
 * refresh read the employee's cookie back and turned the authenticated
 * Branch session into a Staff one. Same harness technique as
 * cash.router.test.ts: pull the real middleware chain off the Router
 * instance and run it against mock req/res, mocking only the service layer
 * and the Prisma calls authenticate's revocation check needs.
 */
vi.mock('./auth.service.js', () => ({
  authService: {
    login: vi.fn(),
    refreshToken: vi.fn(),
    logout: vi.fn(),
    logoutAllDevices: vi.fn(),
    selectEmployee: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    revokedToken: { findFirst: vi.fn() },
  },
}));

const { prisma } = await import('../../lib/prisma.js');
const { authService } = await import('./auth.service.js');
const { authRouter } = await import('./auth.router.js');
const { generateBranchToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    cookies: {},
    originalUrl: '/api/auth/test',
    ip: '127.0.0.1',
    app: { get: () => false },
    ...overrides,
  } as unknown as Request;
}

interface MockResponse extends Response {
  jsonBody?: unknown;
  cookies: Array<{ name: string; value: string }>;
  clearedCookies: string[];
}

/**
 * Built as `any` and cast once at the return — assigning each mocked,
 * `this`-returning Express method individually onto a `Response & {...}`-typed
 * object fights TypeScript's contextual typing of `vi.fn()`'s inferred return
 * type (it wants every method's return type to also carry the extras).
 */
function mockRes(): MockResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
  const res: any = {};
  res.cookies = [];
  res.clearedCookies = [];
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  });
  res.send = vi.fn(() => res);
  res.cookie = vi.fn((name: string, value: string) => {
    res.cookies.push({ name, value });
    return res;
  });
  res.clearCookie = vi.fn((name: string) => {
    res.clearedCookies.push(name);
    return res;
  });
  return res as MockResponse;
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

const BRANCH_ID = randomUUID();
const EMPLOYEE_ID = randomUUID();
const DEVICE_ID = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('POST /select-employee — cookie behavior (Task 122)', () => {
  it('does not set a refresh_token cookie', async () => {
    const branchToken = generateBranchToken(BRANCH_ID);
    vi.mocked(authService.selectEmployee).mockResolvedValue({
      access_token: 'employee-access-token',
      user: { id: EMPLOYEE_ID, role: ROLES.STAFF, email: null, first_name: 'CJ', last_name: 'Lonzaga', branch_ids: [BRANCH_ID], must_change_password: false },
    } as never);

    const handlers = getRouteHandlers(authRouter, 'post', '/select-employee');
    const req = mockReq({ ...authHeader(branchToken), body: { employee_id: EMPLOYEE_ID, device_id: DEVICE_ID } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.cookies.some((c) => c.name === 'refresh_token')).toBe(false);
    expect(res.cookies.some((c) => c.name === 'pc_access_hint')).toBe(false);
  });

  it('does not clear or replace an existing Branch refresh cookie', async () => {
    const branchToken = generateBranchToken(BRANCH_ID);
    vi.mocked(authService.selectEmployee).mockResolvedValue({
      access_token: 'employee-access-token',
      user: { id: EMPLOYEE_ID, role: ROLES.STAFF, email: null, first_name: 'CJ', last_name: 'Lonzaga', branch_ids: [BRANCH_ID], must_change_password: false },
    } as never);

    const handlers = getRouteHandlers(authRouter, 'post', '/select-employee');
    const req = mockReq({
      ...authHeader(branchToken),
      body: { employee_id: EMPLOYEE_ID, device_id: DEVICE_ID },
      cookies: { refresh_token: 'existing-branch-refresh-token' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('response still contains employee identity and employee access token', async () => {
    const branchToken = generateBranchToken(BRANCH_ID);
    vi.mocked(authService.selectEmployee).mockResolvedValue({
      access_token: 'employee-access-token',
      user: { id: EMPLOYEE_ID, role: ROLES.STAFF, email: null, first_name: 'CJ', last_name: 'Lonzaga', branch_ids: [BRANCH_ID], must_change_password: false },
    } as never);

    const handlers = getRouteHandlers(authRouter, 'post', '/select-employee');
    const req = mockReq({ ...authHeader(branchToken), body: { employee_id: EMPLOYEE_ID, device_id: DEVICE_ID } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    const body = res.jsonBody as { data: { access_token: string; user: { id: string } } };
    expect(body.data.access_token).toBe('employee-access-token');
    expect(body.data.user.id).toBe(EMPLOYEE_ID);
  });

  it('rejects a non-branch (e.g. staff) actor from selecting an employee', async () => {
    const { generateStaffToken } = await import('../../test-utils/auth-tokens.js');
    const staffToken = generateStaffToken(BRANCH_ID);

    const handlers = getRouteHandlers(authRouter, 'post', '/select-employee');
    const req = mockReq({ ...authHeader(staffToken), body: { employee_id: EMPLOYEE_ID, device_id: DEVICE_ID } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(authService.selectEmployee).not.toHaveBeenCalled();
  });

  it('propagates a service-level rejection (cross-branch employee) as the mapped AuthError status', async () => {
    const { AuthError } = await import('./auth.types.js');
    const branchToken = generateBranchToken(BRANCH_ID);
    vi.mocked(authService.selectEmployee).mockRejectedValue(
      new AuthError('EMPLOYEE_ACCESS_DENIED', 'This employee is not assigned to your branch', 403),
    );

    const handlers = getRouteHandlers(authRouter, 'post', '/select-employee');
    const req = mockReq({ ...authHeader(branchToken), body: { employee_id: EMPLOYEE_ID, device_id: DEVICE_ID } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe('POST /login — unaffected by the select-employee cookie fix', () => {
  it('still sets the refresh_token and pc_access_hint cookies', async () => {
    vi.mocked(authService.login).mockResolvedValue({
      access_token: 'branch-access-token',
      refreshToken: 'branch-refresh-token',
      user: { id: randomUUID(), role: ROLES.BRANCH, email: 'branch@potatocorner.test', first_name: 'Branch', last_name: 'One', branch_ids: [BRANCH_ID], must_change_password: false },
    } as never);

    const handlers = getRouteHandlers(authRouter, 'post', '/login');
    const req = mockReq({ body: { email: 'branch@potatocorner.test', password: 'correct horse', device_id: DEVICE_ID } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.cookies.some((c) => c.name === 'refresh_token')).toBe(true);
    expect(res.cookies.some((c) => c.name === 'pc_access_hint')).toBe(true);
  });
});
