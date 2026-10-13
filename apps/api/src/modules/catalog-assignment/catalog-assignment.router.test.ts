import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P35R — catalog-management assignment is a Super Admin-only
 * administrative action; Supervisor has no access to this router at all
 * (no self-claiming). Checked against the real middleware chain, same
 * technique as product-categories.router.test.ts.
 */
vi.mock('./catalog-assignment.service.js', () => ({
  catalogAssignmentService: {
    previewAssignment: vi.fn(),
    createAssignment: vi.fn(),
    listHistory: vi.fn(),
    listUnmanaged: vi.fn(),
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

const VALID_BODY = { resource_type: 'INVENTORY_CATEGORY', resource_id: randomUUID(), supervisor_id: randomUUID(), reason: 'Legacy shared master data needs an owner for Phase 20 recipe testing' };

describe('POST /api/catalog-assignments — authorization', () => {
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateBranchToken(randomUUID())), body: VALID_BODY });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogAssignmentService.createAssignment).not.toHaveBeenCalled();
  });

  it('rejects a supervisor actor with 403 — never allowed to self-claim or claim on another supervisor’s behalf', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), body: VALID_BODY });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogAssignmentService.createAssignment).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(catalogAssignmentService.createAssignment).mockResolvedValue({ id: 'assign-1' } as never);
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), body: VALID_BODY });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(catalogAssignmentService.createAssignment).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('422s a malformed body (reason too short) without reaching the service', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'post', '/');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), body: { ...VALID_BODY, reason: 'short' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(catalogAssignmentService.createAssignment).not.toHaveBeenCalled();
  });
});

describe('GET /api/catalog-assignments/preview — authorization', () => {
  it('rejects a supervisor actor with 403', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/preview');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), query: { resource_type: 'INVENTORY_CATEGORY', resource_id: randomUUID() } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogAssignmentService.previewAssignment).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(catalogAssignmentService.previewAssignment).mockResolvedValue({ resource_label: 'Toppings' } as never);
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/preview');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), query: { resource_type: 'INVENTORY_CATEGORY', resource_id: randomUUID() } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(catalogAssignmentService.previewAssignment).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /api/catalog-assignments/unmanaged — authorization', () => {
  it('rejects a supervisor actor with 403', async () => {
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/unmanaged');
    const req = mockReq({ ...authHeader(generateSupervisorToken([randomUUID()])), query: { resource_type: 'INVENTORY_CATEGORY' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(catalogAssignmentService.listUnmanaged).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(catalogAssignmentService.listUnmanaged).mockResolvedValue({ resources: [], total: 0, page: 1, limit: 25 } as never);
    const handlers = getRouteHandlers(catalogAssignmentRouter, 'get', '/unmanaged');
    const req = mockReq({ ...authHeader(generateSuperAdminToken()), query: { resource_type: 'INVENTORY_CATEGORY' } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(catalogAssignmentService.listUnmanaged).toHaveBeenCalledWith('INVENTORY_CATEGORY', 1, 25);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
