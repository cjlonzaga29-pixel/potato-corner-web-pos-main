import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as audit.router.test.ts: no supertest/HTTP-harness
 * dependency exists in this codebase, so the real middleware chain
 * (authenticate, adminOnly, requirePasswordChange, multer) is pulled
 * straight off the Router instance and run against mock req/res objects,
 * with only the service layer mocked. Multer's own middleware calls
 * next() untouched when req's content-type isn't multipart (see
 * make-middleware.js's `if (!is(req, ['multipart'])) return next()`), so
 * a mock req with req.file preset simulates an already-parsed upload.
 */
vi.mock('./branches.service.js', () => ({
  branchesService: {
    bulkAssignGcashQr: vi.fn(),
    getBranchById: vi.fn(),
    updateBranch: vi.fn(),
    uploadGcashQr: vi.fn(),
    changeBranchStatus: vi.fn(),
    getAssignments: vi.fn(),
    assignSupervisor: vi.fn(),
    removeSupervisor: vi.fn(),
    getBranchStats: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: { revokedToken: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

const { branchesService } = await import('./branches.service.js');
const { branchesRouter } = await import('./branches.router.js');
const { BranchError } = await import('./branches.types.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } =
  await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    originalUrl: '/api/branches/gcash-qr/bulk-assign',
    ...overrides,
  } as unknown as Request;
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
  type RouteLayer = {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: Middleware }>;
    };
  };
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

const ROUTE = '/gcash-qr/bulk-assign';

describe('POST /api/branches/gcash-qr/bulk-assign — role guard', () => {
  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSupervisorToken([randomUUID()]);
    const res = mockRes();

    await runHandlers(handlers, mockReq(authHeader(token)), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateStaffToken(randomUUID());
    const res = mockRes();

    await runHandlers(handlers, mockReq(authHeader(token)), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches/gcash-qr/bulk-assign — validation', () => {
  it('returns 422 when the file is missing', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(handlers, mockReq(authHeader(token)), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });

  it('returns 422 when branchIds is not valid JSON', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
      body: { branchIds: 'not-json' },
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });

  it('returns 422 when branchIds fails schema validation', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
      body: { branchIds: JSON.stringify([]) },
    });

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.bulkAssignGcashQr).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches/gcash-qr/bulk-assign — success', () => {
  it('returns 200 with the partial-success shape', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const token = generateSuperAdminToken();
    const res = mockRes();
    const branchId1 = randomUUID();
    const branchId2 = randomUUID();
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
      body: { branchIds: JSON.stringify([branchId1, branchId2]) },
    });
    vi.mocked(branchesService.bulkAssignGcashQr).mockResolvedValue({
      successful: [{ branchId: branchId1, gcashQrUrl: 'https://cdn.test/qr.webp' }],
      failed: [{ branchId: branchId2, error: 'Failed to upload the GCash QR image' }],
    });

    await runHandlers(handlers, req, res);

    expect(branchesService.bulkAssignGcashQr).toHaveBeenCalledWith(
      [branchId1, branchId2],
      { buffer: expect.any(Buffer), originalname: 'qr.png' },
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toMatchObject({
      data: {
        successful: [{ branchId: branchId1, gcashQrUrl: 'https://cdn.test/qr.webp' }],
        failed: [{ branchId: branchId2, error: 'Failed to upload the GCash QR image' }],
      },
      error: null,
    });
  });
});

describe('GET /api/branches/:branchId — role guard', () => {
  const ROUTE = '/:branchId';

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq({ params: { branchId: randomUUID() } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.getBranchById).not.toHaveBeenCalled();
  });

  it('returns 403 for supervisor requesting a branch outside their branch_ids (branchGuard)', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([randomUUID()]);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.getBranchById).not.toHaveBeenCalled();
  });

  it('returns 404 when the service reports the branch as not found', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.getBranchById).mockRejectedValue(
      new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404),
    );

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 200 with the branch for super_admin (bypasses branchGuard)', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.getBranchById).mockResolvedValue({
      id: branchId,
      name: 'Main Branch',
    } as never);

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(branchesService.getBranchById).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({ role: 'super_admin' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('PATCH /api/branches/:branchId — role guard', () => {
  const ROUTE = '/:branchId';
  const VALID_BODY = { name: 'Updated Branch Name' };

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const res = mockRes();
    await runHandlers(
      handlers,
      mockReq({ params: { branchId: randomUUID() }, body: VALID_BODY }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: VALID_BODY }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.updateBranch).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: VALID_BODY }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.updateBranch).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/branches/:branchId — validation', () => {
  const ROUTE = '/:branchId';

  it('returns 422 when name is below the minimum length', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { name: 'A' } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.updateBranch).not.toHaveBeenCalled();
  });

  it('returns 422 when gpsRadiusMeters is out of range', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { gpsRadiusMeters: 5000 } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.updateBranch).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/branches/:branchId — success', () => {
  const ROUTE = '/:branchId';

  it('returns 200 and calls the service with the parsed body', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.updateBranch).mockResolvedValue({
      id: branchId,
      name: 'Updated Branch Name',
    } as never);

    await runHandlers(
      handlers,
      mockReq({
        ...authHeader(token),
        params: { branchId },
        body: { name: 'Updated Branch Name' },
      }),
      res,
    );

    expect(branchesService.updateBranch).toHaveBeenCalledWith(
      branchId,
      { name: 'Updated Branch Name' },
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when the branch does not exist', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.updateBranch).mockRejectedValue(
      new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404),
    );

    await runHandlers(
      handlers,
      mockReq({
        ...authHeader(token),
        params: { branchId },
        body: { name: 'Updated Branch Name' },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /api/branches/:branchId/gcash-qr — role guard', () => {
  const ROUTE = '/:branchId/gcash-qr';

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq({ params: { branchId: randomUUID() } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.uploadGcashQr).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.uploadGcashQr).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches/:branchId/gcash-qr — validation and success', () => {
  const ROUTE = '/:branchId/gcash-qr';

  it('returns 422 when the file is missing', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.uploadGcashQr).not.toHaveBeenCalled();
  });

  it('returns 200 and calls the service with the uploaded file when present', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    const req = mockReq({
      ...authHeader(token),
      params: { branchId },
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
    });
    vi.mocked(branchesService.uploadGcashQr).mockResolvedValue({
      url: 'https://cdn.test/qr.webp',
      key: 'branch-gcash-qr/x.webp',
    });

    await runHandlers(handlers, req, res);

    expect(branchesService.uploadGcashQr).toHaveBeenCalledWith(branchId, {
      buffer: expect.any(Buffer),
      originalname: 'qr.png',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toMatchObject({
      data: { url: 'https://cdn.test/qr.webp', key: 'branch-gcash-qr/x.webp' },
      error: null,
    });
  });

  it('returns 404 when the branch does not exist', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    const req = mockReq({
      ...authHeader(token),
      params: { branchId },
      file: { buffer: Buffer.from('fake'), originalname: 'qr.png' } as Express.Multer.File,
    });
    vi.mocked(branchesService.uploadGcashQr).mockRejectedValue(
      new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404),
    );

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('PATCH /api/branches/:branchId/status — role guard', () => {
  const ROUTE = '/:branchId/status';
  const VALID_BODY = { status: 'inactive' };

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const res = mockRes();
    await runHandlers(
      handlers,
      mockReq({ params: { branchId: randomUUID() }, body: VALID_BODY }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: VALID_BODY }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.changeBranchStatus).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: VALID_BODY }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.changeBranchStatus).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/branches/:branchId/status — validation and success', () => {
  const ROUTE = '/:branchId/status';

  it('returns 422 for an invalid status value', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { status: 'bogus' } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.changeBranchStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and calls the service with the new status', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.changeBranchStatus).mockResolvedValue({
      id: branchId,
      status: 'closed',
    } as never);

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { status: 'closed' } }),
      res,
    );

    expect(branchesService.changeBranchStatus).toHaveBeenCalledWith(
      branchId,
      'closed',
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 409 when the service reports active shifts blocking a close', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'patch', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.changeBranchStatus).mockRejectedValue(
      new BranchError(
        'BRANCH_HAS_ACTIVE_SHIFTS',
        'Cannot close a branch with active shifts — close all shifts first',
        409,
      ),
    );

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { status: 'closed' } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('GET /api/branches/:branchId/assignments — role guard', () => {
  const ROUTE = '/:branchId/assignments';

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq({ params: { branchId: randomUUID() } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.getAssignments).not.toHaveBeenCalled();
  });

  it('returns 403 for supervisor requesting a branch outside their branch_ids', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([randomUUID()]);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.getAssignments).not.toHaveBeenCalled();
  });

  it('returns 200 for a supervisor requesting their own branch', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();
    vi.mocked(branchesService.getAssignments).mockResolvedValue([]);

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(branchesService.getAssignments).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({ role: 'supervisor' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /api/branches/:branchId/assignments — role guard', () => {
  const ROUTE = '/:branchId/assignments';
  const VALID_BODY = { userId: randomUUID() };

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const res = mockRes();
    await runHandlers(
      handlers,
      mockReq({ params: { branchId: randomUUID() }, body: VALID_BODY }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: VALID_BODY }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.assignSupervisor).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: VALID_BODY }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.assignSupervisor).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches/:branchId/assignments — validation and success', () => {
  const ROUTE = '/:branchId/assignments';

  it('returns 422 when userId is not a valid uuid', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { userId: 'not-a-uuid' } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(branchesService.assignSupervisor).not.toHaveBeenCalled();
  });

  it('returns 201 and calls the service with the branch and user ids', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const userId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.assignSupervisor).mockResolvedValue({
      id: 'assignment-1',
      userId,
      branchId,
    } as never);

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { userId } }),
      res,
    );

    expect(branchesService.assignSupervisor).toHaveBeenCalledWith(
      userId,
      branchId,
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 422 when the target user is not a supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'post', ROUTE);
    const branchId = randomUUID();
    const userId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.assignSupervisor).mockRejectedValue(
      new BranchError(
        'USER_NOT_SUPERVISOR',
        'Only users with the supervisor role can be assigned to a branch',
        422,
      ),
    );

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId }, body: { userId } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });
});

describe('DELETE /api/branches/:branchId/assignments/:userId — role guard', () => {
  const ROUTE = '/:branchId/assignments/:userId';

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const res = mockRes();
    await runHandlers(
      handlers,
      mockReq({ params: { branchId: randomUUID(), userId: randomUUID() } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const userId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId, userId } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.removeSupervisor).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const userId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId, userId } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.removeSupervisor).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/branches/:branchId/assignments/:userId — success', () => {
  const ROUTE = '/:branchId/assignments/:userId';

  it('returns 204 and calls the service with branchId and userId', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const userId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.removeSupervisor).mockResolvedValue(undefined);

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId, userId } }),
      res,
    );

    expect(branchesService.removeSupervisor).toHaveBeenCalledWith(
      userId,
      branchId,
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });

  it('returns 404 when no active assignment exists', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const userId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.removeSupervisor).mockRejectedValue(
      new BranchError(
        'ASSIGNMENT_NOT_FOUND',
        'No active assignment found for this user at this branch',
        404,
      ),
    );

    await runHandlers(
      handlers,
      mockReq({ ...authHeader(token), params: { branchId, userId } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('GET /api/branches/:branchId/stats — role guard', () => {
  const ROUTE = '/:branchId/stats';

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq({ params: { branchId: randomUUID() } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.getBranchStats).not.toHaveBeenCalled();
  });

  it('returns 403 for supervisor requesting a branch outside their branch_ids', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([randomUUID()]);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.getBranchStats).not.toHaveBeenCalled();
  });

  it('returns 200 for super_admin (bypasses branchGuard)', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'get', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.getBranchStats).mockResolvedValue({
      activeShiftsCount: 0,
      todayTransactionCount: 0,
      todayRevenue: 0,
      todayGrossSales: 0,
      todayVat: 0,
      todayExpenses: 0,
      todayNetProfit: 0,
      activeStaffCount: 0,
      lowStockIngredientCount: 0,
    });

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(branchesService.getBranchStats).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({ role: 'super_admin' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
