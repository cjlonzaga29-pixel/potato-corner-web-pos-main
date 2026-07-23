import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ROLES } from '@potato-corner/shared';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    revokedToken: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../modules/cash/cash.repository.js', () => ({
  cashRepository: {
    findActiveShift: vi.fn(),
  },
}));

const { prisma } = await import('../lib/prisma.js');
const { cashRepository } = await import('../modules/cash/cash.repository.js');
const { config } = await import('../config/index.js');
const { authenticate, revokedTokenHash } = await import('./authenticate.js');
const { authorize, adminOnly, adminOrSupervisor, allRoles } = await import('./authorize.js');
const { branchGuard } = await import('./branch-guard.js');
const { shiftGuard } = await import('./shift-guard.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import(
  '../test-utils/auth-tokens.js'
);

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, ...overrides } as unknown as Request;
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
  return res;
}

/** Runs middleware in sequence, stopping at the first one that doesn't call next(). Returns true if every middleware called next(). */
async function runChain(middlewares: Middleware[], req: Request, res: Response): Promise<boolean> {
  for (const middleware of middlewares) {
    let calledNext = false;
    await middleware(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    if (!calledNext) return false;
  }
  return true;
}

function authHeader(token: string): Partial<Request> {
  return { headers: { authorization: `Bearer ${token}` } };
}

// jwtPayloadSchema validates user_id and branch_ids as real UUIDs — this
// only matters for tests that route through the real authenticate()
// middleware (which re-parses the decoded token against that schema);
// tests that set req.user directly don't need them.
const BRANCH_1 = randomUUID();
const BRANCH_2 = randomUUID();
const BRANCH_OTHER = randomUUID();

beforeEach(() => {
  vi.mocked(prisma.revokedToken.findFirst).mockReset();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
  vi.mocked(cashRepository.findActiveShift).mockReset();
});

describe('authenticate middleware', () => {
  it('returns 401 TOKEN_MISSING when no Authorization header is present', async () => {
    const req = mockReq();
    const res = mockRes();
    await authenticate(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'TOKEN_MISSING' } }));
  });

  it('returns 401 TOKEN_INVALID for a malformed Bearer token', async () => {
    const req = mockReq(authHeader('not-a-real-jwt'));
    const res = mockRes();
    await authenticate(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'TOKEN_INVALID' } }));
  });

  it('returns 401 TOKEN_EXPIRED for an expired JWT', async () => {
    const token = generateSuperAdminToken({ expired: true });
    const req = mockReq(authHeader(token));
    const res = mockRes();
    await authenticate(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'TOKEN_EXPIRED' } }));
  });

  it('returns 401 TOKEN_REVOKED for a blacklisted token', async () => {
    const token = generateSuperAdminToken();
    vi.mocked(prisma.revokedToken.findFirst).mockImplementation((async (args: { where: { tokenHash: string } }) =>
      args.where.tokenHash === revokedTokenHash(token) ? { id: 'revoked-1' } : null) as never);
    const req = mockReq(authHeader(token));
    const res = mockRes();
    await authenticate(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'TOKEN_REVOKED' } }));
  });

  it('attaches the decoded payload to req.user and calls next() for a valid token', async () => {
    const staffUserId = randomUUID();
    const token = generateStaffToken(BRANCH_1, { userId: staffUserId, email: 'staff@potatocorner.test' });
    const req = mockReq(authHeader(token));
    const res = mockRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ user_id: staffUserId, role: ROLES.STAFF, branch_ids: [BRANCH_1] });
  });
});

describe('authorize middleware', () => {
  function reqWithRole(role: (typeof ROLES)[keyof typeof ROLES], branchIds: string[] = ['branch-1']): Request {
    if (role === ROLES.SUPER_ADMIN) {
      return mockReq({ user: { user_id: 'u1', role, email: 'a@test.com', iat: 0, exp: 9999999999 } });
    }
    return mockReq({ user: { user_id: 'u1', role, email: 'a@test.com', branch_ids: branchIds, iat: 0, exp: 9999999999 } });
  }

  it('super admin passes adminOnly', () => {
    const req = reqWithRole(ROLES.SUPER_ADMIN);
    const res = mockRes();
    const next = vi.fn();
    adminOnly(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('supervisor fails adminOnly with 403 INSUFFICIENT_PERMISSIONS', () => {
    const req = reqWithRole(ROLES.SUPERVISOR);
    const res = mockRes();
    adminOnly(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }),
      }),
    );
  });

  it('non-production 403 includes diagnostic details', () => {
    const req = reqWithRole(ROLES.SUPERVISOR);
    const res = mockRes();
    adminOnly(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INSUFFICIENT_PERMISSIONS',
          details: expect.objectContaining({
            authenticated: true,
            userId: 'u1',
            role: ROLES.SUPERVISOR,
            allowedRoles: expect.arrayContaining([ROLES.SUPER_ADMIN]),
          }),
        }),
      }),
    );
  });

  it('production 403 omits diagnostic details', () => {
    const wasProduction = config.isProduction;
    (config as { isProduction: boolean }).isProduction = true;
    try {
      const req = reqWithRole(ROLES.SUPERVISOR);
      const res = mockRes();
      adminOnly(req, res, vi.fn());
      expect(res.json).toHaveBeenCalledWith({
        data: null,
        error: { code: 'INSUFFICIENT_PERMISSIONS' },
        meta: null,
      });
    } finally {
      (config as { isProduction: boolean }).isProduction = wasProduction;
    }
  });

  it('missing req.user still reports authenticated: false in diagnostics', () => {
    const req = mockReq();
    const res = mockRes();
    adminOnly(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          details: expect.objectContaining({ authenticated: false, userId: null, role: null }),
        }),
      }),
    );
  });

  it('staff fails adminOnly with 403', () => {
    const req = reqWithRole(ROLES.STAFF);
    const res = mockRes();
    adminOnly(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('super admin passes adminOrSupervisor', () => {
    const req = reqWithRole(ROLES.SUPER_ADMIN);
    const res = mockRes();
    const next = vi.fn();
    adminOrSupervisor(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('supervisor passes adminOrSupervisor', () => {
    const req = reqWithRole(ROLES.SUPERVISOR);
    const res = mockRes();
    const next = vi.fn();
    adminOrSupervisor(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('staff fails adminOrSupervisor with 403', () => {
    const req = reqWithRole(ROLES.STAFF);
    const res = mockRes();
    adminOrSupervisor(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('every role passes allRoles', () => {
    for (const role of [ROLES.SUPER_ADMIN, ROLES.SUPERVISOR, ROLES.STAFF] as const) {
      const req = reqWithRole(role);
      const res = mockRes();
      const next = vi.fn();
      allRoles(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('authorize() is a factory usable with arbitrary role combinations', () => {
    const customGuard = authorize(ROLES.SUPERVISOR, ROLES.STAFF);
    const req = reqWithRole(ROLES.SUPER_ADMIN);
    const res = mockRes();
    customGuard(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('branch-guard middleware', () => {
  it('super admin bypasses the branch check entirely regardless of branch_id', () => {
    const req = mockReq({ user: { user_id: 'a1', role: ROLES.SUPER_ADMIN, email: 'a@test.com', iat: 0, exp: 9999999999 } });
    const res = mockRes();
    const next = vi.fn();
    branchGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('supervisor with branch_id in their branch_ids array passes', () => {
    const req = mockReq({
      user: { user_id: 's1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1', 'branch-2'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-2' },
    });
    const res = mockRes();
    const next = vi.fn();
    branchGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('supervisor with branch_id NOT in their branch_ids array returns 403 BRANCH_ACCESS_DENIED', () => {
    const req = mockReq({
      user: { user_id: 's1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-99' },
    });
    const res = mockRes();
    branchGuard(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('supervisor with valid branch_id in params passes', () => {
    const req = mockReq({
      user: { user_id: 's1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    branchGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('supervisor with valid branch_id in query passes', () => {
    const req = mockReq({
      user: { user_id: 's1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      query: { branchId: 'branch-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    branchGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('supervisor with valid branch_id in body passes', () => {
    const req = mockReq({
      user: { user_id: 's1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      body: { branchId: 'branch-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    branchGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('staff with matching branch_id passes', () => {
    const req = mockReq({
      user: { user_id: 't1', role: ROLES.STAFF, email: 't@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    branchGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('staff with non-matching branch_id returns 403 BRANCH_ACCESS_DENIED', () => {
    const req = mockReq({
      user: { user_id: 't1', role: ROLES.STAFF, email: 't@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-2' },
    });
    const res = mockRes();
    branchGuard(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('request with no branch_id anywhere returns 400 BRANCH_ID_REQUIRED', () => {
    const req = mockReq({
      user: { user_id: 't1', role: ROLES.STAFF, email: 't@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
    });
    const res = mockRes();
    branchGuard(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ID_REQUIRED' } }));
  });
});

describe('shift-guard middleware', () => {
  it('staff with an active shift passes and attaches it to req.activeShift', async () => {
    const shift = { id: 'shift-1', cashierId: 't1', branchId: 'branch-1', status: 'active' };
    vi.mocked(cashRepository.findActiveShift).mockResolvedValue(shift as never);
    const req = mockReq({
      user: { user_id: 't1', role: ROLES.STAFF, email: 't@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    await shiftGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.activeShift).toEqual(shift);
  });

  it('staff with no active shift returns 403 NO_ACTIVE_SHIFT', async () => {
    vi.mocked(cashRepository.findActiveShift).mockResolvedValue(null);
    const req = mockReq({
      user: { user_id: 't1', role: ROLES.STAFF, email: 't@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-1' },
    });
    const res = mockRes();
    await shiftGuard(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'NO_ACTIVE_SHIFT' } }));
  });

  it('supervisor bypasses the shift check', async () => {
    const req = mockReq({
      user: { user_id: 's1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
      params: { branchId: 'branch-1' },
    });
    const res = mockRes();
    const next = vi.fn();
    await shiftGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(cashRepository.findActiveShift).not.toHaveBeenCalled();
  });

  it('super admin bypasses the shift check', async () => {
    const req = mockReq({ user: { user_id: 'a1', role: ROLES.SUPER_ADMIN, email: 'a@test.com', iat: 0, exp: 9999999999 } });
    const res = mockRes();
    const next = vi.fn();
    await shiftGuard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(cashRepository.findActiveShift).not.toHaveBeenCalled();
  });
});

describe('cross-role access boundary tests (full authenticate + authorize/branch-guard chains)', () => {
  it('staff JWT cannot access an admin-only endpoint — 403', async () => {
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq(authHeader(token));
    const res = mockRes();
    const ok = await runChain([authenticate, adminOnly], req, res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('staff JWT cannot access a supervisor-only endpoint — 403', async () => {
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq(authHeader(token));
    const res = mockRes();
    const supervisorOnly = authorize(ROLES.SUPERVISOR);
    const ok = await runChain([authenticate, supervisorOnly], req, res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('supervisor JWT cannot access an admin-only endpoint — 403', async () => {
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq(authHeader(token));
    const res = mockRes();
    const ok = await runChain([authenticate, adminOnly], req, res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('super admin JWT can access admin, supervisor, and branch-scoped endpoints', async () => {
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_OTHER } });
    const res = mockRes();
    const ok = await runChain([authenticate, adminOnly, branchGuard], req, res);
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('supervisor JWT can access their own branch data', async () => {
    const token = generateSupervisorToken([BRANCH_1, BRANCH_2]);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_2 } });
    const res = mockRes();
    const ok = await runChain([authenticate, adminOrSupervisor, branchGuard], req, res);
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("supervisor JWT cannot access another supervisor's branch data — 403 BRANCH_ACCESS_DENIED", async () => {
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { branchId: BRANCH_OTHER } });
    const res = mockRes();
    const ok = await runChain([authenticate, adminOrSupervisor, branchGuard], req, res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });
});
