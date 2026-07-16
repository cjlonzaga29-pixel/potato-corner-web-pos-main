import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as transactions.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate, adminOnly, requirePasswordChange, validate) is pulled
 * straight off the Router instance and run against mock req/res objects,
 * with only the service layer mocked.
 */
vi.mock('./fraud.service.js', () => ({
  fraudService: {
    listAlerts: vi.fn(),
    getAlertById: vi.fn(),
    investigateAlert: vi.fn(),
    dismissAlert: vi.fn(),
    escalateAlert: vi.fn(),
    triggerManualScan: vi.fn(),
  },
}));

const { fraudService } = await import('./fraud.service.js');
const { fraudRouter } = await import('./fraud.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');
const { FraudError } = await import('./fraud.types.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/fraud/test', ...overrides } as unknown as Request;
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

const ALERT_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fraud routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'get', path: '/' },
    { method: 'get', path: '/:id' },
    { method: 'post', path: '/:id/investigate' },
    { method: 'post', path: '/:id/dismiss' },
    { method: 'post', path: '/:id/escalate' },
    { method: 'post', path: '/run' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(fraudRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('GET / — role guard', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'get', '/');
    const token = generateSupervisorToken([randomUUID()]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fraudService.listAlerts).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'get', '/');
    const token = generateStaffToken(randomUUID());
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fraudService.listAlerts).not.toHaveBeenCalled();
  });

  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(fraudService.listAlerts).mockResolvedValue({ alerts: [], total: 0, page: 1, limit: 25 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fraudService.listAlerts).toHaveBeenCalled();
  });
});

describe('GET /:id', () => {
  it('returns 404 for an unknown id', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'get', '/:id');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: 'missing' } });
    const res = mockRes();
    vi.mocked(fraudService.getAlertById).mockRejectedValue(new FraudError('FRAUD_ALERT_NOT_FOUND', 'Fraud alert not found', 404));

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'FRAUD_ALERT_NOT_FOUND' }) }));
  });
});

describe('POST /:id/investigate — role guard', () => {
  it('returns 403 for non-super_admin (supervisor)', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/investigate');
    const token = generateSupervisorToken([randomUUID()]);
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fraudService.investigateAlert).not.toHaveBeenCalled();
  });

  it('returns 403 for non-super_admin (staff)', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/investigate');
    const token = generateStaffToken(randomUUID());
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fraudService.investigateAlert).not.toHaveBeenCalled();
  });

  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/investigate');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: {} });
    const res = mockRes();
    vi.mocked(fraudService.investigateAlert).mockResolvedValue({ id: ALERT_1, status: 'investigating' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fraudService.investigateAlert).toHaveBeenCalled();
  });
});

describe('POST /:id/dismiss — validation', () => {
  it('returns 422 when dismissal_reason is missing', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/dismiss');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(fraudService.dismissAlert).not.toHaveBeenCalled();
  });

  it('returns 422 when dismissal_reason is shorter than 10 characters', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/dismiss');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: { dismissal_reason: 'short' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(fraudService.dismissAlert).not.toHaveBeenCalled();
  });

  it('returns 200 with a valid dismissal_reason', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/dismiss');
    const token = generateSuperAdminToken();
    const req = mockReq({
      ...authHeader(token),
      params: { id: ALERT_1 },
      body: { dismissal_reason: 'Confirmed with cashier, not fraud' },
    });
    const res = mockRes();
    vi.mocked(fraudService.dismissAlert).mockResolvedValue({ id: ALERT_1, status: 'dismissed' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fraudService.dismissAlert).toHaveBeenCalledWith(ALERT_1, expect.any(String), {
      dismissalReason: 'Confirmed with cashier, not fraud',
    });
  });
});

describe('POST /:id/escalate', () => {
  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/escalate');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: {} });
    const res = mockRes();
    vi.mocked(fraudService.escalateAlert).mockResolvedValue({ id: ALERT_1, status: 'escalated' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fraudService.escalateAlert).toHaveBeenCalled();
  });

  it('returns 403 for non-super_admin', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/:id/escalate');
    const token = generateStaffToken(randomUUID());
    const req = mockReq({ ...authHeader(token), params: { id: ALERT_1 }, body: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fraudService.escalateAlert).not.toHaveBeenCalled();
  });
});

describe('POST /run — role guard and behavior', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/run');
    const token = generateSupervisorToken([randomUUID()]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/run');
    const token = generateStaffToken(randomUUID());
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('enqueues a scan and returns 202 with the job id for super_admin', async () => {
    vi.mocked(fraudService.triggerManualScan).mockResolvedValue({ jobId: 'job-123' });
    const handlers = getRouteHandlers(fraudRouter, 'post', '/run');
    const userId = randomUUID();
    const token = generateSuperAdminToken({ userId });
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(fraudService.triggerManualScan).toHaveBeenCalledWith(userId);
    expect(res.status).toHaveBeenCalledWith(202);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toEqual({
      data: { job_id: 'job-123', message: 'Fraud detection scan enqueued' },
      error: null,
      meta: null,
    });
  });
});
