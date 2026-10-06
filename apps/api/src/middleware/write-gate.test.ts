import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { ROLES } from '@potato-corner/shared';

/**
 * POS-PERF-P16 — the server-enforced write gate that blocks checkout and
 * every inventory-mutating route during a free-plan maintenance window
 * (Render deploy swap / rollback). Exercised directly against the real
 * middleware function (not through a router), same technique as
 * rate-limiter.test.ts, with only the Postgres-backed repository, the audit
 * logger, and token verification mocked.
 */
vi.mock('../modules/settings/settings.repository.js', () => ({
  settingsRepository: {
    findSystemSetting: vi.fn(),
  },
}));

vi.mock('./audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/verify-access-token.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/verify-access-token.js')>('../lib/verify-access-token.js');
  return {
    ...actual,
    verifyAccessToken: vi.fn(),
  };
});

const { settingsRepository } = await import('../modules/settings/settings.repository.js');
const { recordAuditLog } = await import('./audit-log.js');
const { verifyAccessToken, AccessTokenError } = await import('../lib/verify-access-token.js');
const { writeGate, getActiveGatedRequestCount } = await import('./write-gate.js');

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, method: 'POST', path: '/api/transactions', ip: '127.0.0.1', ...overrides } as unknown as Request;
}

/** A real EventEmitter so res.once('finish'/'close', ...) behaves like the genuine Express Response. */
function mockRes(): Response & { statusCode?: number; jsonBody?: unknown } {
  const emitter = new EventEmitter();
  const res = emitter as unknown as Response & { statusCode?: number; jsonBody?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as unknown as Response['json'];
  res.set = vi.fn(() => res) as unknown as Response['set'];
  return res;
}

/**
 * Runs the gate and then fires 'finish' as a real Express response always
 * eventually does, so the in-flight counter (module-level state, shared
 * across every test in this file) never leaks between unrelated test
 * cases. The dedicated counter describe block below calls `writeGate`
 * directly instead, specifically to observe the count *before* finishing.
 */
async function runGate(req: Request, res: Response): Promise<boolean> {
  let nextCalled = false;
  await writeGate(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);
  (res as unknown as EventEmitter).emit('finish');
  return nextCalled;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writeGate — which paths/methods it protects', () => {
  it('lets a GET on a gated path through without even checking the DB (reads stay available during maintenance)', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: true, reason: 'x' } } as never);
    const req = mockReq({ method: 'GET', path: '/api/transactions' });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(true);
    expect(settingsRepository.findSystemSetting).not.toHaveBeenCalled();
  });

  it('ignores a path this gate does not own (e.g. /api/employees) even while the gate is closed', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: true, reason: 'x' } } as never);
    const req = mockReq({ method: 'POST', path: '/api/employees' });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(true);
    expect(settingsRepository.findSystemSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['POST /api/transactions (checkout)', 'POST', '/api/transactions'],
    ['POST /api/transactions/sync-offline', 'POST', '/api/transactions/sync-offline'],
    ['POST /api/transactions/:id/void', 'POST', '/api/transactions/tx-1/void'],
    ['POST /api/transactions/:id/refund', 'POST', '/api/transactions/tx-1/refund'],
    ['POST /api/inventory', 'POST', '/api/inventory'],
    ['PATCH /api/inventory/:id', 'PATCH', '/api/inventory/ing-1'],
    ['DELETE /api/inventory/:id', 'DELETE', '/api/inventory/ing-1'],
    ['POST /api/product-inventory', 'POST', '/api/product-inventory'],
    ['POST /api/universal-inventory/items', 'POST', '/api/universal-inventory/items'],
    ['POST /api/product-components', 'POST', '/api/product-components'],
    ['POST /api/branches/:id/inventory/count', 'POST', '/api/branches/branch-1/inventory/count'],
    ['POST /api/branches/:id/inventory/transfer', 'POST', '/api/branches/branch-1/inventory/transfer'],
    ['POST /api/branches/:id/inventory-stock/:itemId/receive', 'POST', '/api/branches/branch-1/inventory-stock/item-1/receive'],
    ['POST /api/branches/:id/inventory-stock/:itemId/adjust', 'POST', '/api/branches/branch-1/inventory-stock/item-1/adjust'],
  ])('blocks %s with 503 while the gate is closed', async (_label, method, path) => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: true, reason: 'deploy swap' } } as never);
    const req = mockReq({ method, path });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect((res as unknown as { jsonBody: { error: { code: string; details: { reason: string } } } }).jsonBody.error).toMatchObject({
      code: 'SERVICE_WRITE_GATE_CLOSED',
      details: { reason: 'deploy swap' },
    });
  });

  it('never gates an unrelated branch-scoped route (e.g. /api/branches/:id/status)', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: true, reason: 'x' } } as never);
    const req = mockReq({ method: 'PUT', path: '/api/branches/branch-1/status' });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(true);
  });
});

describe('writeGate — open/default state', () => {
  it('lets a gated POST through when enabled:false', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: false, reason: null } } as never);
    const req = mockReq();
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(true);
  });

  it('defaults open (no row at all) — matches every pre-P16 deployment with no gate row ever written', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    const req = mockReq();
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(true);
  });

  it('fails closed on a malformed stored value (row exists, shape does not match WriteGateStateValue) instead of silently permitting the write', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { closed: true } } as never);
    const req = mockReq();
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('writeGate — narrowly authorized maintenance bypass', () => {
  beforeEach(() => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: true, reason: 'deploy swap' } } as never);
  });

  it('rejects a request with no bypass header, even from an authenticated super admin', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue({ user_id: 'admin-1', role: ROLES.SUPER_ADMIN } as never);
    const req = mockReq({ headers: { authorization: 'Bearer admin-token' } });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects the bypass header with no authentication at all', async () => {
    const req = mockReq({ headers: { 'x-maintenance-bypass': 'retrying a stuck job' } });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('rejects the bypass header from an authenticated non-admin (e.g. branch account)', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue({ user_id: 'branch-1', role: ROLES.BRANCH } as never);
    const req = mockReq({ headers: { authorization: 'Bearer branch-token', 'x-maintenance-bypass': 'trying anyway' } });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('rejects the bypass header when the token fails verification', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new AccessTokenError('TOKEN_EXPIRED', 'jwt expired'));
    const req = mockReq({ headers: { authorization: 'Bearer expired-token', 'x-maintenance-bypass': 'retrying a stuck job' } });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('lets a super admin with both the bypass header and a valid admin token through, and audit-logs it', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue({ user_id: 'admin-1', role: ROLES.SUPER_ADMIN } as never);
    const req = mockReq({
      method: 'POST',
      path: '/api/transactions/tx-1/void',
      headers: { authorization: 'Bearer admin-token', 'x-maintenance-bypass': 'retrying a stuck inventory deduction job' },
    });
    const res = mockRes();

    const next = await runGate(req, res);

    expect(next).toBe(true);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MAINTENANCE_GATE_BYPASS',
        actorId: 'admin-1',
        actorRole: ROLES.SUPER_ADMIN,
        afterState: expect.objectContaining({ reason: 'retrying a stuck inventory deduction job' }),
      }),
    );
  });
});

describe('writeGate — in-flight request counter (verified-drain signal)', () => {
  it('increments on entry and decrements once the response finishes, for both allowed and blocked requests', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: false, reason: null } } as never);
    const req = mockReq();
    const res = mockRes();

    const pending = writeGate(req, res, vi.fn() as unknown as NextFunction);
    expect(getActiveGatedRequestCount()).toBe(1);
    await pending;
    (res as unknown as EventEmitter).emit('finish');

    expect(getActiveGatedRequestCount()).toBe(0);
  });

  it('never double-decrements if both finish and close fire for the same response', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({ value: { enabled: false, reason: null } } as never);
    const req = mockReq();
    const res = mockRes();

    await writeGate(req, res, vi.fn() as unknown as NextFunction);
    (res as unknown as EventEmitter).emit('finish');
    (res as unknown as EventEmitter).emit('close');

    expect(getActiveGatedRequestCount()).toBe(0);
  });

  it('a request whose DB read is still in flight when an operator closes the gate stays counted through the read, the handler, and the response — a drain poll mid-flight must never see 0', async () => {
    let resolveRead!: (value: { value: { enabled: boolean; reason: string | null } }) => void;
    vi.mocked(settingsRepository.findSystemSetting).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }) as never,
    );
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;

    const pending = writeGate(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);

    // Request is in-flight, still awaiting its DB read. A drain poll (GET
    // /api/settings/write-gate) right now must see 1, not 0 — the request
    // has not reached a handler yet, let alone finished.
    expect(getActiveGatedRequestCount()).toBe(1);
    expect(nextCalled).toBe(false);

    // The DB read finally resolves with the state as it was the instant the
    // query ran — "open" — even though an operator may have closed the gate
    // (written enabled:true) at any point while this read was in flight.
    // That race is not this middleware's to resolve (every write after the
    // read observes the new state); its only obligation is to keep counting
    // this request until its response actually finishes.
    resolveRead({ value: { enabled: false, reason: null } });
    await pending;

    expect(nextCalled).toBe(true);
    // Handler is still running (no 'finish' emitted yet) — must remain counted.
    expect(getActiveGatedRequestCount()).toBe(1);

    (res as unknown as EventEmitter).emit('finish');
    expect(getActiveGatedRequestCount()).toBe(0);
  });

  it('does not count requests outside the gate\'s scope at all', async () => {
    const req = mockReq({ method: 'GET', path: '/api/transactions' });
    const res = mockRes();

    await writeGate(req, res, vi.fn() as unknown as NextFunction);

    expect(getActiveGatedRequestCount()).toBe(0);
  });
});
