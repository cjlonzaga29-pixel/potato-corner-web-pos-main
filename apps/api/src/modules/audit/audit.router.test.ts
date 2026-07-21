import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as fraud.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate, adminOnly, requirePasswordChange) is pulled straight off
 * the Router instance and run against mock req/res objects, with only the
 * service layer mocked.
 */
vi.mock('./audit.service.js', () => ({
  auditService: {
    listLogs: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

const { auditService } = await import('./audit.service.js');
const { auditRouter } = await import('./audit.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/audit/test', ...overrides } as unknown as Request;
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/audit — authentication', () => {
  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('GET /api/audit — role guard', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateSupervisorToken([randomUUID()]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(auditService.listLogs).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateStaffToken(randomUUID());
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(auditService.listLogs).not.toHaveBeenCalled();
  });

  it('returns 200 for super_admin', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(auditService.listLogs).mockResolvedValue({ logs: [], total: 0, page: 1, limit: 25 });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(auditService.listLogs).toHaveBeenCalled();
  });
});

describe('GET /api/audit — validation', () => {
  it('returns 422 for an invalid actor_id (not a uuid)', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { actor_id: 'not-a-uuid' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(auditService.listLogs).not.toHaveBeenCalled();
  });

  it('returns 422 when limit exceeds the max', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { limit: '500' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(auditService.listLogs).not.toHaveBeenCalled();
  });
});

describe('GET /api/audit — filters and response', () => {
  it('maps query filters onto the service call', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const branchId = randomUUID();
    const actorId = randomUUID();
    const req = mockReq({
      ...authHeader(token),
      query: {
        action: 'FRAUD_ALERT_DISMISSED',
        entity_type: 'fraud_alert',
        entity_id: 'alert-1',
        actor_id: actorId,
        branch_id: branchId,
        date_from: '2026-07-01',
        date_to: '2026-07-14',
        page: '2',
        limit: '10',
      },
    });
    const res = mockRes();
    const logRow = {
      id: 'log-1',
      action: 'FRAUD_ALERT_DISMISSED',
      entity_type: 'fraud_alert',
      entity_id: 'alert-1',
      actor_id: actorId,
      actor_role: 'super_admin',
      actor: { id: actorId, first_name: 'Juan', last_name: 'Dela Cruz', email: 'juan@example.com' },
      branch_id: branchId,
      branch: { id: branchId, name: 'Manila' },
      before_state: null,
      after_state: null,
      ip_address: null,
      user_agent: null,
      previous_hash: '0'.repeat(64),
      current_hash: 'abc123',
      created_at: '2026-07-14T00:00:00.000Z',
    };
    vi.mocked(auditService.listLogs).mockResolvedValue({ logs: [logRow], total: 1, page: 2, limit: 10 });

    await runHandlers(handlers, req, res);

    expect(auditService.listLogs).toHaveBeenCalledWith({
      action: 'FRAUD_ALERT_DISMISSED',
      entityType: 'fraud_alert',
      entityId: 'alert-1',
      actorId,
      branchId,
      dateFrom: '2026-07-01',
      dateTo: '2026-07-14',
      page: 2,
      limit: 10,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toEqual({
      data: { logs: [logRow], total: 1, page: 2, limit: 10 },
      error: null,
      meta: null,
    });
  });

  it('defaults page to 1 and limit to 25 when omitted', async () => {
    const handlers = getRouteHandlers(auditRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(auditService.listLogs).mockResolvedValue({ logs: [], total: 0, page: 1, limit: 25 });

    await runHandlers(handlers, req, res);

    expect(auditService.listLogs).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 25 }),
    );
  });
});
