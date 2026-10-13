import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P36 — the write (POST /) and /preview and /unmanaged routes are
 * retired along with the manual-assignment surface (catalog authority is
 * now derived live from active branch assignments, see
 * apps/api/src/lib/catalog-authority.ts). Only the Admin-only read-only
 * audit history route (GET /) survives.
 */
vi.mock('./catalog-assignment.service.js', () => ({
  catalogAssignmentService: {
    listHistory: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { catalogAssignmentService } = await import('./catalog-assignment.service.js');
const { catalogAssignmentRouter } = await import('./catalog-assignment.router.js');
const { generateSuperAdminToken, generateBranchToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/catalog-assignments', ...overrides } as unknown as Request;
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
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
});

describe('GET /api/catalog-assignments — authorization', () => {
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), query: { resource_type: 'INVENTORY_CATEGORY', resource_id: randomUUID() } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogAssignmentService.listHistory).not.toHaveBeenCalled();
  });

  it('rejects a supervisor actor with 403 — audit history stays Admin-only', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), query: { resource_type: 'INVENTORY_CATEGORY', resource_id: randomUUID() } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogAssignmentService.listHistory).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(catalogAssignmentService.listHistory).mockResolvedValue([] as never);
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), query: { resource_type: 'INVENTORY_CATEGORY', resource_id: randomUUID() } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(catalogAssignmentService.listHistory).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('422s a malformed query without reaching the service', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), query: { resource_type: 'NOT_A_REAL_TYPE', resource_id: randomUUID() } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(catalogAssignmentService.listHistory).not.toHaveBeenCalled();
  });
});
