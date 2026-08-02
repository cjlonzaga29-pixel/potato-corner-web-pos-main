import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/** CR-008 R13/R15 — branch has no write access to Option Group identity. */
vi.mock('./product-options.service.js', () => ({
  productOptionsService: {
    getAllGroups: vi.fn(),
    getGroupById: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    createOption: vi.fn(),
    updateOption: vi.fn(),
    getAssignedVariantsForOption: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn() } },
}));

const { prisma } = await import('../../lib/prisma.js');
const { productOptionsService } = await import('./product-options.service.js');
const { productOptionsRouter } = await import('./product-options.router.js');
const { generateBranchToken, generateSuperAdminToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/product-options', ...overrides } as unknown as Request;
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

describe('POST /api/product-options — branch cannot create an Option Group (R13/R15)', () => {
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(productOptionsRouter, 'post', '/');
    const req = mockReq({
      ...authHeader(generateBranchToken(randomUUID())),
      body: { code: 'flavor', name: 'Flavor', selection_type: 'SINGLE', min_selections: 0, required: false, is_active: true },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productOptionsService.createGroup).not.toHaveBeenCalled();
  });

  it('allows a super_admin actor through to the service', async () => {
    vi.mocked(productOptionsService.createGroup).mockResolvedValue({ id: 'group-1' } as never);
    const handlers = getRouteHandlers(productOptionsRouter, 'post', '/');
    const req = mockReq({
      ...authHeader(generateSuperAdminToken()),
      body: { code: 'flavor', name: 'Flavor', selection_type: 'SINGLE', min_selections: 0, required: false, is_active: true },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productOptionsService.createGroup).toHaveBeenCalled();
  });
});

describe('GET /api/product-options/:groupId/options/:optionId/variants — reverse lookup', () => {
  it('rejects a branch actor with 403, never reaching the service', async () => {
    const handlers = getRouteHandlers(productOptionsRouter, 'get', '/:groupId/options/:optionId/variants');
    const req = mockReq({
      ...authHeader(generateBranchToken(randomUUID())),
      params: { groupId: 'group-1', optionId: 'option-1' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(productOptionsService.getAssignedVariantsForOption).not.toHaveBeenCalled();
  });

  it('allows a supervisor actor through and returns the assigned variants', async () => {
    vi.mocked(productOptionsService.getAssignedVariantsForOption).mockResolvedValue([
      { product_variant_id: 'variant-1', variant_name: 'Regular', product_id: 'product-1', product_name: 'Cheese Fries' },
    ] as never);
    const handlers = getRouteHandlers(productOptionsRouter, 'get', '/:groupId/options/:optionId/variants');
    const req = mockReq({
      ...authHeader(generateSupervisorToken([randomUUID()])),
      params: { groupId: 'group-1', optionId: 'option-1' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(productOptionsService.getAssignedVariantsForOption).toHaveBeenCalledWith('group-1', 'option-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as unknown as { jsonBody: { data: { variants: unknown[] } } }).jsonBody.data.variants).toHaveLength(1);
  });
});
