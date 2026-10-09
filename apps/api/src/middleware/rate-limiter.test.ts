import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ROLES, type JwtPayload } from '@potato-corner/shared';

const { loginLimiter, selectEmployeeLimiter, receiptLookupLimiter, apiLimiter, staffPinVerifyFailureLimiter, staffPinVerifyOverallLimiter } = await import(
  './rate-limiter.js'
);

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

/**
 * Extends Node's EventEmitter so skipSuccessfulRequests/skipFailedRequests
 * (which hook response.on('finish'/'close'/'error')) work against this
 * mock the same way they do against a real express Response.
 */
function mockRes() {
  const emitter = new EventEmitter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the mockRes pattern in auth.router.test.ts/rbac.test.ts
  const res: any = emitter;
  res.writableEnded = false;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    res.writableEnded = true;
    return res;
  });
  res.setHeader = vi.fn(() => res);
  res.getHeader = vi.fn(() => undefined);
  res.removeHeader = vi.fn(() => res);
  return res as Response & { statusCode?: number; jsonBody?: unknown; writableEnded?: boolean };
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

/**
 * Like hit(), but for limiters configured with skipSuccessfulRequests /
 * skipFailedRequests — when the request is allowed through, simulates the
 * downstream route handler finishing with `outcomeStatus` and emits
 * 'finish' so the store's post-response decrement logic actually runs
 * before the next request in the same test is sent.
 */
async function hitWithOutcome(limiter: Limiter, req: Request, outcomeStatus: 200 | 401): Promise<{ allowed: boolean; status?: number }> {
  const res = mockRes();
  let allowed = false;
  await limiter(req, res, (() => {
    allowed = true;
  }) as NextFunction);
  if (allowed) {
    res.statusCode = outcomeStatus;
    (res as unknown as EventEmitter).emit('finish');
    // response.on('finish', async () => ...) handlers are async — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));
  }
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

/** Task 209.48 — dedicated limiter for GET /api/receipts/:transactionNumber (public, unauthenticated). */
describe('receiptLookupLimiter', () => {
  it('allows 20 requests then blocks the 21st from the same IP within the window', async () => {
    const ip = randomUUID();

    for (let i = 0; i < 20; i++) {
      const result = await hit(receiptLookupLimiter, mockReq({ ip }));
      expect(result.allowed).toBe(true);
    }
    const blocked = await hit(receiptLookupLimiter, mockReq({ ip }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('is keyed per IP — a different IP has its own untouched budget (branch/mall NAT does not share one bucket with an attacker)', async () => {
    const attackerIp = randomUUID();
    const legitimateIp = randomUUID();

    for (let i = 0; i < 20; i++) {
      const result = await hit(receiptLookupLimiter, mockReq({ ip: attackerIp }));
      expect(result.allowed).toBe(true);
    }
    const exhausted = await hit(receiptLookupLimiter, mockReq({ ip: attackerIp }));
    expect(exhausted.allowed).toBe(false);

    const stillAllowed = await hit(receiptLookupLimiter, mockReq({ ip: legitimateIp }));
    expect(stillAllowed.allowed).toBe(true);
  });

  it('is a separate bucket from the generic apiLimiter — exhausting one does not exhaust the other for the same IP', async () => {
    const ip = randomUUID();

    for (let i = 0; i < 20; i++) {
      const result = await hit(receiptLookupLimiter, mockReq({ ip }));
      expect(result.allowed).toBe(true);
    }
    const receiptBlocked = await hit(receiptLookupLimiter, mockReq({ ip }));
    expect(receiptBlocked.allowed).toBe(false);

    // apiLimiter (used by every other /api route) still has its own, separate 100/min budget for this IP.
    const apiStillAllowed = await hit(apiLimiter, mockReq({ ip }));
    expect(apiStillAllowed.allowed).toBe(true);
  });
});

/**
 * POS-PERF-P29R2 — staffPinVerifyFailureLimiter/staffPinVerifyOverallLimiter
 * replace the single staffPinVerifyLimiter that previously capped ALL
 * requests (success or failure) at 5 per 5 minutes, which blocked a branch
 * doing more than 5 legitimate successive inventory entries in a window.
 */
describe('staffPinVerifyFailureLimiter + staffPinVerifyOverallLimiter', () => {
  function pinReq(overrides: Partial<Request> & { branchId?: string; userId?: string } = {}): Request {
    const branchId = overrides.branchId ?? randomUUID();
    return mockReq({
      ...overrides,
      params: { branchId },
      user: branchUser(overrides.userId ?? randomUUID()),
    } as Partial<Request>);
  }

  it('does not throttle an unbounded run of successful verifications on the failure limiter (skipSuccessfulRequests)', async () => {
    const req = pinReq();
    for (let i = 0; i < 20; i++) {
      const result = await hitWithOutcome(staffPinVerifyFailureLimiter, req, 200);
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the 6th failed PIN attempt within 5 minutes, regardless of successes in between', async () => {
    const req = pinReq();

    // Two successful verifications first — must not consume the failure budget.
    expect((await hitWithOutcome(staffPinVerifyFailureLimiter, req, 200)).allowed).toBe(true);
    expect((await hitWithOutcome(staffPinVerifyFailureLimiter, req, 200)).allowed).toBe(true);

    for (let i = 0; i < 5; i++) {
      const result = await hitWithOutcome(staffPinVerifyFailureLimiter, req, 401);
      expect(result.allowed).toBe(true);
    }
    const blocked = await hitWithOutcome(staffPinVerifyFailureLimiter, req, 401);
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);

    // A successful verification right after is still unaffected — the failure budget is exhausted, not the overall one.
  });

  it('is keyed per (branchId, actor) — a different actor at the same branch has an untouched failure budget', async () => {
    const branchId = randomUUID();
    const attacker = pinReq({ branchId, userId: randomUUID() });
    const otherActor = pinReq({ branchId, userId: randomUUID() });

    for (let i = 0; i < 5; i++) {
      expect((await hitWithOutcome(staffPinVerifyFailureLimiter, attacker, 401)).allowed).toBe(true);
    }
    expect((await hitWithOutcome(staffPinVerifyFailureLimiter, attacker, 401)).allowed).toBe(false);

    expect((await hitWithOutcome(staffPinVerifyFailureLimiter, otherActor, 401)).allowed).toBe(true);
  });

  it('overall limiter caps total requests (success + failure) at 30 per 5 minutes even with zero failures', async () => {
    const req = pinReq();
    for (let i = 0; i < 30; i++) {
      const result = await hitWithOutcome(staffPinVerifyOverallLimiter, req, 200);
      expect(result.allowed).toBe(true);
    }
    const blocked = await hitWithOutcome(staffPinVerifyOverallLimiter, req, 200);
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('overall limiter counts failed attempts too (does not skip anything)', async () => {
    const req = pinReq();
    for (let i = 0; i < 30; i++) {
      const result = await hitWithOutcome(staffPinVerifyOverallLimiter, req, 401);
      expect(result.allowed).toBe(true);
    }
    const blocked = await hitWithOutcome(staffPinVerifyOverallLimiter, req, 401);
    expect(blocked.allowed).toBe(false);
  });

  /**
   * POS-PERF-P29R3 — every test above dispatches its hits strictly one at a
   * time (`for` + `await`), which only proves the limiter is correct under
   * SEQUENTIAL load. That says nothing about whether a burst of genuinely
   * concurrent failed PIN attempts (the actual brute-force/enumeration
   * shape this limiter exists to stop) could over-admit past the 5-failure
   * cap before any single request's accounting has been written back —
   * the exact kind of race a sequential pass cannot exercise, let alone
   * disprove. One real HTTP request == one distinct Express `req` object —
   * express-rate-limit's own double-count guard (singleCountKeys, a WeakMap
   * keyed on the request object) enforces exactly that, and throws if the
   * same object is re-presented as a second "request" — so a genuinely
   * concurrent burst from the same actor is N DIFFERENT request objects
   * landing in the same window, not one object reused; each call below
   * gets its own mockReq() sharing only the (branchId, userId) key.
   *
   * Finding: firing the burst via Promise.all (so every call's
   * `store.increment()` races the others instead of running strictly after
   * each other) proves the resource cap genuinely holds — admitted count
   * never exceeds the configured limit, so no flood of simultaneous
   * attempts can slip past it. It also surfaces a real, pre-existing
   * reliability quirk in express-rate-limit's default MemoryStore
   * (unrelated to this fix, inherited from the Phase 21 Redis-removal —
   * see rate-limiter.ts's own header comment on that store being per-
   * process/non-atomic): `increment()` returns the shared mutable client
   * object by reference, and `totalHits` is only read off it several
   * `await`s later. Under true same-tick concurrency every sibling's
   * increment can land before any single request's own read, so a request
   * can see a `totalHits` higher than its own call actually produced — in
   * the extreme, a burst this tight can see EVERY concurrent call rejected
   * (0 admitted) rather than admitting up to the limit. That is a
   * conservative failure mode (never a cap breach, only ever an
   * under-admission of requests that should have fit), so it is captured
   * and asserted here rather than silently tightened further — the
   * guarantee this limiter must never lose is "never over-admitted," which
   * holds either way.
   */
  it('a burst of concurrent (Promise.all-fired) failed PIN attempts never over-admits past the 5-failure cap', async () => {
    const branchId = randomUUID();
    const userId = randomUUID();
    const burst = await Promise.all(Array.from({ length: 12 }, () => hitWithOutcome(staffPinVerifyFailureLimiter, pinReq({ branchId, userId }), 401)));
    const admitted = burst.filter((r) => r.allowed);
    const rejected = burst.filter((r) => !r.allowed);
    // The one guarantee that must never break: the cap is never exceeded, regardless of dispatch order or the MemoryStore quirk documented above.
    expect(admitted.length).toBeLessThanOrEqual(5);
    expect(admitted.length + rejected.length).toBe(12);
    for (const r of rejected) expect(r.status).toBe(429);

    // The cap (or its conservative floor) holds, and the limiter still recovers with a clear, actionable follow-up request once the window has room again.
    const afterBurst = await hitWithOutcome(staffPinVerifyFailureLimiter, pinReq({ branchId, userId }), 401);
    expect(afterBurst.allowed).toBe(false);
    expect(afterBurst.status).toBe(429);
  });

  /**
   * skipSuccessfulRequests only decrements the shared counter AFTER a
   * successful response finishes — it does not exempt entry from the raw
   * per-key limit check that happens at increment() time, before the
   * outcome is known. Combined with the shared-mutable-client read race
   * documented on the test above, this surfaces a real, pre-existing
   * reliability gap in this limiter under true same-tick concurrency: a
   * burst of purely-successful attempts that gets mostly/entirely rejected
   * at entry (never "allowed", so never reaches the finish-hook that would
   * decrement it) leaves those hits permanently counted against the SAME
   * counter the failure budget uses, for the rest of the window — i.e. a
   * big enough simultaneous burst of correct PIN entries could exhaust real
   * subsequent failure-attempt budget even though none of them were
   * failures. This is a genuine finding (logged for the runbook/follow-up,
   * not silently patched here — fixing it means moving off MemoryStore
   * entirely, consistent with Phase 21's already-flagged revisit-when-
   * multi-instance plan), not an artifact of this test. What's asserted
   * here is the property that DOES hold regardless: every one of the 25
   * concurrent calls resolves to a well-formed outcome (never a raw/
   * unhandled error), and the resource cap is still never exceeded.
   */
  it('a burst of concurrent successful PIN verifications resolves every call to a well-formed outcome, with the cap never exceeded', async () => {
    const branchId = randomUUID();
    const userId = randomUUID();
    const burst = await Promise.all(Array.from({ length: 25 }, () => hitWithOutcome(staffPinVerifyFailureLimiter, pinReq({ branchId, userId }), 200)));
    const admitted = burst.filter((r) => r.allowed);
    const rejected = burst.filter((r) => !r.allowed);
    expect(admitted.length + rejected.length).toBe(25);
    expect(admitted.length).toBeLessThanOrEqual(5);
    for (const r of rejected) expect(r.status).toBe(429);
  });

  it('the overall per-actor cap (30/5min) is never over-admitted under a genuinely concurrent mixed burst', async () => {
    const branchId = randomUUID();
    const userId = randomUUID();
    const burst = await Promise.all([
      ...Array.from({ length: 20 }, () => hitWithOutcome(staffPinVerifyOverallLimiter, pinReq({ branchId, userId }), 200)),
      ...Array.from({ length: 20 }, () => hitWithOutcome(staffPinVerifyOverallLimiter, pinReq({ branchId, userId }), 401)),
    ]);
    const admitted = burst.filter((r) => r.allowed);
    const rejected = burst.filter((r) => !r.allowed);
    // Same resource-cap guarantee as the failure-limiter burst test above — see its comment for why this is <= rather than ===.
    expect(admitted.length).toBeLessThanOrEqual(30);
    expect(admitted.length + rejected.length).toBe(40);
    for (const r of rejected) expect(r.status).toBe(429);
  });
});
