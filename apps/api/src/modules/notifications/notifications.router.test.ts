import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as fraud.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate) is pulled straight off the Router instance and run against
 * mock req/res objects, with only the service layer mocked.
 */
vi.mock('./notifications.service.js', () => ({
  notificationsService: {
    listForRecipient: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
}));

const { notificationsService } = await import('./notifications.service.js');
const { notificationsRouter } = await import('./notifications.router.js');
const { generateSuperAdminToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');
const { NotificationError } = await import('./notifications.types.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/notifications/test', ...overrides } as unknown as Request;
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

const NOTIF_1 = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifications routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'get', path: '/' },
    { method: 'patch', path: '/:id/read' },
    { method: 'patch', path: '/read-all' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(notificationsRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('GET /', () => {
  it('returns 200 with the recipient-scoped list for any authenticated role', async () => {
    const handlers = getRouteHandlers(notificationsRouter, 'get', '/');
    const token = generateStaffToken(randomUUID());
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(notificationsService.listForRecipient).mockResolvedValue({
      notifications: [],
      total: 0,
      unread_count: 0,
      page: 1,
      limit: 25,
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(notificationsService.listForRecipient).toHaveBeenCalledWith(expect.any(String), { page: 1, limit: 25 });
  });

  it('returns 422 for an invalid page param', async () => {
    const handlers = getRouteHandlers(notificationsRouter, 'get', '/');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), query: { page: 'not-a-number' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(notificationsService.listForRecipient).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/read', () => {
  it('returns 200 and marks the notification read for its owner', async () => {
    const handlers = getRouteHandlers(notificationsRouter, 'patch', '/:id/read');
    const userId = randomUUID();
    const token = generateSuperAdminToken({ userId });
    const req = mockReq({ ...authHeader(token), params: { id: NOTIF_1 } });
    const res = mockRes();
    vi.mocked(notificationsService.markRead).mockResolvedValue(undefined);

    await runHandlers(handlers, req, res);

    expect(notificationsService.markRead).toHaveBeenCalledWith(NOTIF_1, userId);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 (not 500) when the notification belongs to a different recipient', async () => {
    const handlers = getRouteHandlers(notificationsRouter, 'patch', '/:id/read');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { id: NOTIF_1 } });
    const res = mockRes();
    vi.mocked(notificationsService.markRead).mockRejectedValue(new NotificationError('NOTIFICATION_NOT_FOUND', 'Notification not found', 404));

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'NOTIFICATION_NOT_FOUND' }) }),
    );
  });
});

describe('PATCH /read-all', () => {
  it('returns 200 with the updated count', async () => {
    const handlers = getRouteHandlers(notificationsRouter, 'patch', '/read-all');
    const token = generateSuperAdminToken();
    const req = mockReq(authHeader(token));
    const res = mockRes();
    vi.mocked(notificationsService.markAllRead).mockResolvedValue({ updated_count: 4 });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toEqual({
      data: { updated_count: 4 },
      error: null,
      meta: null,
    });
  });
});
