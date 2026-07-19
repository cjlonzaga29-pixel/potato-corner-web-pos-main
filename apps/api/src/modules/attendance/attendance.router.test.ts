import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as cash.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate, authorize guards, branchGuard, validate) is pulled
 * straight off the Router instance and run against mock req/res objects,
 * with only the service layer mocked.
 */
vi.mock('./attendance.service.js', () => ({
  attendanceService: {
    clockIn: vi.fn(),
    clockOut: vi.fn(),
    manualOverride: vi.fn(),
    getByBranch: vi.fn(),
    getByEmployee: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { attendanceService } = await import('./attendance.service.js');
const { attendanceRouter } = await import('./attendance.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/attendance/test', ...overrides } as unknown as Request;
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
const EMPLOYEE_1 = randomUUID();
const RECORD_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('attendance routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'post', path: '/clock-in' },
    { method: 'post', path: '/clock-out' },
    { method: 'get', path: '/branch/:branchId' },
    { method: 'get', path: '/employee/:employeeId' },
    { method: 'post', path: '/override' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(attendanceRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('POST /clock-in', () => {
  it('returns 201 on a valid body from a staff member clocking themselves in', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/clock-in');
    const token = generateStaffToken(BRANCH_1, { userId: EMPLOYEE_1 });
    const req = mockReq({
      ...authHeader(token),
      body: { employee_id: EMPLOYEE_1, branch_id: BRANCH_1, gps_lat: 14.5995, gps_lng: 120.9842 },
    });
    const res = mockRes();
    vi.mocked(attendanceService.clockIn).mockResolvedValue({ id: RECORD_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(attendanceService.clockIn).toHaveBeenCalled();
  });

  it('rejects a body missing gps_lat/gps_lng with 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/clock-in');
    const token = generateStaffToken(BRANCH_1, { userId: EMPLOYEE_1 });
    const req = mockReq({ ...authHeader(token), body: { employee_id: EMPLOYEE_1, branch_id: BRANCH_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(attendanceService.clockIn).not.toHaveBeenCalled();
  });

  it('a staff member clocking in for a branch they are not assigned to gets 403 from branchGuard', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/clock-in');
    const token = generateStaffToken(BRANCH_1, { userId: EMPLOYEE_1 });
    const req = mockReq({
      ...authHeader(token),
      body: { employee_id: EMPLOYEE_1, branch_id: BRANCH_2, gps_lat: 14.5995, gps_lng: 120.9842 },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
    expect(attendanceService.clockIn).not.toHaveBeenCalled();
  });
});

describe('POST /clock-out', () => {
  it('returns 200 on a valid body', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/clock-out');
    const token = generateStaffToken(BRANCH_1, { userId: EMPLOYEE_1 });
    const req = mockReq({ ...authHeader(token), body: { employee_id: EMPLOYEE_1, branch_id: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(attendanceService.clockOut).mockResolvedValue({ id: RECORD_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 RECORD_NOT_FOUND when the service reports no open record', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/clock-out');
    const token = generateStaffToken(BRANCH_1, { userId: EMPLOYEE_1 });
    const req = mockReq({ ...authHeader(token), body: { employee_id: EMPLOYEE_1, branch_id: BRANCH_1 } });
    const res = mockRes();
    const { AttendanceError } = await import('./attendance.types.js');
    vi.mocked(attendanceService.clockOut).mockRejectedValue(new AttendanceError('RECORD_NOT_FOUND', 'No open record', 404));

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'RECORD_NOT_FOUND' }) }));
  });
});

describe('GET /branch/:branchId', () => {
  it('returns 200 with paginated records for a supervisor scoped to their own branch', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'get', '/branch/:branchId');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_1 }, query: { page: '1', limit: '25' } });
    const res = mockRes();
    vi.mocked(attendanceService.getByBranch).mockResolvedValue({ records: [], total: 0, page: 1, limit: 25 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(attendanceService.getByBranch).toHaveBeenCalledWith(BRANCH_1, expect.objectContaining({ page: 1, limit: 25 }));
  });

  it('staff cannot list branch attendance — 403', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'get', '/branch/:branchId');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(attendanceService.getByBranch).not.toHaveBeenCalled();
  });

  it("blocks a supervisor from listing another branch's attendance — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'get', '/branch/:branchId');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_2 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(attendanceService.getByBranch).not.toHaveBeenCalled();
  });
});

describe('GET /employee/:employeeId', () => {
  it('returns 200 with paginated records', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'get', '/employee/:employeeId');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { employeeId: EMPLOYEE_1 } });
    const res = mockRes();
    vi.mocked(attendanceService.getByEmployee).mockResolvedValue({ records: [], total: 0, page: 1, limit: 25 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(attendanceService.getByEmployee).toHaveBeenCalledWith(EMPLOYEE_1, expect.objectContaining({ page: 1, limit: 25 }));
  });
});

describe('POST /override', () => {
  it('supervisor happy path returns 201', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/override');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({
      ...authHeader(token),
      body: { original_record_id: RECORD_1, correction_reason: 'Employee forgot to clock out' },
    });
    const res = mockRes();
    vi.mocked(attendanceService.manualOverride).mockResolvedValue({ id: randomUUID(), status: 'corrected' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(attendanceService.manualOverride).toHaveBeenCalled();
  });

  it('staff role is rejected — 403', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/override');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      body: { original_record_id: RECORD_1, correction_reason: 'Employee forgot to clock out' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(attendanceService.manualOverride).not.toHaveBeenCalled();
  });

  it('super_admin is rejected — supervisorOnly excludes super_admin too', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/override');
    const token = generateSuperAdminToken();
    const req = mockReq({
      ...authHeader(token),
      body: { original_record_id: RECORD_1, correction_reason: 'Employee forgot to clock out' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(attendanceService.manualOverride).not.toHaveBeenCalled();
  });

  it('rejects a correction_reason under 10 characters with 422', async () => {
    const handlers = getRouteHandlers(attendanceRouter, 'post', '/override');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: { original_record_id: RECORD_1, correction_reason: 'short' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(attendanceService.manualOverride).not.toHaveBeenCalled();
  });
});
