import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ROLES, type JwtPayload } from '@potato-corner/shared';

const { loginLimiter, selectEmployeeLimiter } = await import('./rate-limiter.js');

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: {},
    ip: randomUUID(),
    // express-rate-limit reads req.app.get('trust proxy') to decide how to
    // validate req.ip — same stub used by auth.router.test.ts.
    app: { get: () => false },
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the mockRes pattern in auth.router.test.ts/rbac.test.ts
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  });
  res.setHeader = vi.fn(() => res);
  res.getHeader = vi.fn(() => undefined);
  res.removeHeader = vi.fn(() => res);
  return res as Response & { statusCode?: number; jsonBody?: unknown };
}

type Limiter = RequestHandler;

/** Runs one request through a rate-limit middleware in isolation and reports whether it passed through (next() called) or was rejected (429). */
async function hit(limiter: Limiter, req: Request): Promise<{ allowed: boolean; status?: number }> {
  const res = mockRes();
  let allowed = false;
  await limiter(req, res, (() => {
    allowed = true;
  }) as NextFunction);
  return { allowed, status: allowed ? undefined : res.statusCode };
}

function branchUser(userId: string): JwtPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    user_id: userId,
    role: ROLES.BRANCH,
    email: 'branch@potatocorner.test',
    branch_ids: [randomUUID()],
    must_change_password: false,
    iat: now,
    exp: now + 900,
  };
}

describe('loginLimiter', () => {
  it('does not share a bucket between different device IDs on the same IP (branch-wide lockout fix)', async () => {
    const ip = randomUUID();
    const deviceA = randomUUID();
    const deviceB = randomUUID();

    for (let i = 0; i < 10; i++) {
      const result = await hit(loginLimiter, mockReq({ ip, body: { device_id: deviceA } }));
      expect(result.allowed).toBe(true);
    }
    const exhausted = await hit(loginLimiter, mockReq({ ip, body: { device_id: deviceA } }));
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.status).toBe(429);

    // A second device behind the same NAT'd IP still has its own untouched budget.
    const stillAllowed = await hit(loginLimiter, mockReq({ ip, body: { device_id: deviceB } }));
    expect(stillAllowed.allowed).toBe(true);
  });

  it('still limits repeated requests from the same IP + device_id combination', async () => {
    const ip = randomUUID();
    const deviceId = randomUUID();

    for (let i = 0; i < 10; i++) {
      const result = await hit(loginLimiter, mockReq({ ip, body: { device_id: deviceId } }));
      expect(result.allowed).toBe(true);
    }
    const blocked = await hit(loginLimiter, mockReq({ ip, body: { device_id: deviceId } }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('falls back to a per-IP bucket without crashing when device_id is missing from the body', async () => {
    const ip = randomUUID();

    for (let i = 0; i < 10; i++) {
      const result = await hit(loginLimiter, mockReq({ ip, body: {} }));
      expect(result.allowed).toBe(true);
    }
    const blocked = await hit(loginLimiter, mockReq({ ip, body: {} }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });
});

describe('selectEmployeeLimiter', () => {
  it('keys by the authenticated branch session (req.user.user_id), not by IP', async () => {
    const ip = randomUUID();
    const sessionA = branchUser(randomUUID());
    const sessionB = branchUser(randomUUID());

    for (let i = 0; i < 10; i++) {
      const result = await hit(selectEmployeeLimiter, mockReq({ ip, user: sessionA }));
      expect(result.allowed).toBe(true);
    }
    const exhausted = await hit(selectEmployeeLimiter, mockReq({ ip, user: sessionA }));
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.status).toBe(429);

    // A different branch session sharing the same egress IP is unaffected.
    const stillAllowed = await hit(selectEmployeeLimiter, mockReq({ ip, user: sessionB }));
    expect(stillAllowed.allowed).toBe(true);
  });

  it('still limits repeated requests from the same authenticated session (endpoint behavior unchanged)', async () => {
    const session = branchUser(randomUUID());

    for (let i = 0; i < 10; i++) {
      const result = await hit(selectEmployeeLimiter, mockReq({ ip: randomUUID(), user: session }));
      expect(result.allowed).toBe(true);
    }
    const blocked = await hit(selectEmployeeLimiter, mockReq({ ip: randomUUID(), user: session }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });
});
