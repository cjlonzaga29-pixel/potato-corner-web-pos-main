import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Same technique as cash.router.test.ts: no supertest/HTTP-harness dependency
 * exists in this codebase, so the real middleware chain (authenticate,
 * authorize guards, branchGuard, shiftGuard, requirePasswordChange, validate)
 * is pulled straight off the Router instance and run against mock req/res
 * objects, with only the service layer (and shiftGuard's cashRepository
 * dependency) mocked.
 */
vi.mock('./transactions.service.js', () => ({
  transactionsService: {
    createTransaction: vi.fn(),
    listTransactions: vi.fn(),
    getTransactionById: vi.fn(),
    voidTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    markReceiptPrinted: vi.fn(),
    syncOfflineTransactions: vi.fn(),
    uploadPaymentProof: vi.fn(),
    getPaymentProofUrl: vi.fn(),
  },
}));

vi.mock('../cash/cash.repository.js', () => ({
  cashRepository: { findActiveShift: vi.fn() },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    revokedToken: { findFirst: vi.fn() },
    // requireActiveEmployee's per-request status re-check (employees.repository.ts's findStatusById).
    user: { findUnique: vi.fn().mockResolvedValue({ status: 'active', isActive: true }) },
  },
}));

// branchGuard/hasBranchAccess/getAccessibleBranchIds resolve Supervisor
// scope from the database via branch-access.ts, never the JWT's branch_ids
// — mocked here so the supervisor cases below don't depend on a real
// Prisma connection.
vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { prisma } = await import('../../lib/prisma.js');
const { cashRepository } = await import('../cash/cash.repository.js');
const { transactionsService } = await import('./transactions.service.js');
const { transactionsRouter } = await import('./transactions.router.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { generateSuperAdminToken, generateSupervisorToken, generateStaffToken } = await import('../../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/transactions/test', ...overrides } as unknown as Request;
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

const BRANCH_1 = randomUUID();
const BRANCH_2 = randomUUID();
const SHIFT_1 = randomUUID();
const TXN_1 = randomUUID();

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    branch_id: BRANCH_1,
    shift_id: SHIFT_1,
    items: [{ product_id: randomUUID(), product_variant_id: randomUUID(), quantity: 1 }],
    payment_method: 'cash',
    cash_tendered: 100,
    is_offline_transaction: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
  vi.mocked(cashRepository.findActiveShift).mockResolvedValue({ id: SHIFT_1 } as never);
  // Default: BRANCH_1 is active — matches every supervisor test's "own
  // branch"; BRANCH_2 is deliberately excluded, matching the "outside
  // assigned scope" tests below.
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([BRANCH_1]);
});

describe('transactions routes — authentication', () => {
  const protectedRoutes: Array<{ method: string; path: string }> = [
    { method: 'post', path: '/' },
    { method: 'post', path: '/sync-offline' },
    { method: 'get', path: '/' },
    { method: 'get', path: '/:transactionId' },
    { method: 'post', path: '/:transactionId/void' },
    { method: 'post', path: '/:transactionId/refund' },
    { method: 'post', path: '/:transactionId/receipt-printed' },
    { method: 'post', path: '/payment-proof' },
    { method: 'get', path: '/:transactionId/payment-proof' },
  ];

  it.each(protectedRoutes)('$method $path returns 401 with no Authorization header', async ({ method, path }) => {
    const handlers = getRouteHandlers(transactionsRouter, method, path);
    const req = mockReq();
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('POST / — happy path', () => {
  it('a valid transaction payload from staff (with an active shift) reaches the service and returns 201', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validCreateBody() });
    const res = mockRes();
    vi.mocked(transactionsService.createTransaction).mockResolvedValue({ id: TXN_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(transactionsService.createTransaction).toHaveBeenCalled();
  });

  it('overrides a mismatched client-supplied shift_id with the shiftGuard-resolved active shift for staff', async () => {
    const OTHER_SHIFT = randomUUID();
    vi.mocked(cashRepository.findActiveShift).mockResolvedValue({ id: SHIFT_1 } as never);
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validCreateBody({ shift_id: OTHER_SHIFT }) });
    const res = mockRes();
    vi.mocked(transactionsService.createTransaction).mockResolvedValue({ id: TXN_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(transactionsService.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ shiftId: SHIFT_1 }), null);
  });

  it('staff with no active shift is blocked by shiftGuard before reaching the service — 403 NO_ACTIVE_SHIFT', async () => {
    vi.mocked(cashRepository.findActiveShift).mockResolvedValue(null);
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validCreateBody() });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'NO_ACTIVE_SHIFT' } }));
    expect(transactionsService.createTransaction).not.toHaveBeenCalled();
  });

  it('supervisor/super_admin are exempt from shiftGuard', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), body: validCreateBody() });
    const res = mockRes();
    vi.mocked(transactionsService.createTransaction).mockResolvedValue({ id: TXN_1 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(cashRepository.findActiveShift).not.toHaveBeenCalled();
  });

  it('a staff member posting for a branch they are not assigned to gets 403 from branchGuard', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_2);
    const req = mockReq({ ...authHeader(token), body: validCreateBody({ branch_id: BRANCH_1 }) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
    expect(transactionsService.createTransaction).not.toHaveBeenCalled();
  });
});

describe('POST / — validate middleware', () => {
  it('a cash payment missing cash_tendered gets 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validCreateBody({ cash_tendered: undefined }) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(transactionsService.createTransaction).not.toHaveBeenCalled();
  });

  it('a GCash payment missing gcash_reference_number gets 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      body: validCreateBody({ payment_method: 'gcash', cash_tendered: undefined, gcash_manually_verified: true }),
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(transactionsService.createTransaction).not.toHaveBeenCalled();
  });

  it('a GCash payment missing payment_proof_key/payment_proof_type gets 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      body: validCreateBody({
        payment_method: 'gcash',
        cash_tendered: undefined,
        gcash_reference_number: '1234567890',
        gcash_manually_verified: true,
      }),
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(transactionsService.createTransaction).not.toHaveBeenCalled();
  });

  it('an offline GCash payment gets 422 — non-cash sales cannot be queued offline (no proof-capture blob queue exists)', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      body: validCreateBody({
        payment_method: 'gcash',
        cash_tendered: undefined,
        gcash_reference_number: '1234567890',
        gcash_manually_verified: true,
        payment_proof_key: 'branch-1/shift-1/user-1-123.webp',
        payment_proof_type: 'live_capture',
        is_offline_transaction: true,
      }),
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(transactionsService.createTransaction).not.toHaveBeenCalled();
  });
});

function validSyncOfflineBody(overrides: Record<string, unknown> = {}) {
  return {
    branch_id: BRANCH_1,
    transactions: [
      {
        offline_provisional_number: `PC-MAIN01-20260719-OFFLINE-0001`,
        shift_id: SHIFT_1,
        items: [{ product_id: randomUUID(), product_variant_id: randomUUID(), quantity: 1 }],
        payment_method: 'cash',
        cash_tendered: 100,
        client_created_at: Date.now(),
      },
    ],
    ...overrides,
  };
}

describe('POST /sync-offline', () => {
  it('is registered before /:transactionId, matching the /hold registration-order pattern', () => {
    // Would throw "No route registered" if Express's route-order matching
    // captured "/sync-offline" as a :transactionId param instead.
    expect(() => getRouteHandlers(transactionsRouter, 'post', '/sync-offline')).not.toThrow();
  });

  it('a valid batch from staff (with an active shift) reaches the service and returns 200', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/sync-offline');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validSyncOfflineBody() });
    const res = mockRes();
    vi.mocked(transactionsService.syncOfflineTransactions).mockResolvedValue({ results: [], synced_count: 0 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(transactionsService.syncOfflineTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: BRANCH_1, cashierId: expect.any(String) }),
      null,
    );
  });

  it('an empty transactions array gets 422 before reaching the service', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/sync-offline');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validSyncOfflineBody({ transactions: [] }) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(transactionsService.syncOfflineTransactions).not.toHaveBeenCalled();
  });

  it('staff with no active shift is blocked by shiftGuard before reaching the service — 403 NO_ACTIVE_SHIFT', async () => {
    vi.mocked(cashRepository.findActiveShift).mockResolvedValue(null);
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/sync-offline');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), body: validSyncOfflineBody() });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(transactionsService.syncOfflineTransactions).not.toHaveBeenCalled();
  });

  it('a staff member posting for a branch they are not assigned to gets 403 from branchGuard', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/sync-offline');
    const token = generateStaffToken(BRANCH_2);
    const req = mockReq({ ...authHeader(token), body: validSyncOfflineBody({ branch_id: BRANCH_1 }) });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(transactionsService.syncOfflineTransactions).not.toHaveBeenCalled();
  });
});

/**
 * multer's own middleware needs a real Node.js request stream to parse
 * multipart bytes, which this codebase's mockReq/mockRes harness (no
 * supertest/HTTP layer) can't provide — same limitation the rest of this
 * file's harness comment documents. These tests instead skip past the multer
 * handler (index 4 in the registered chain) and preset req.file/req.body the
 * way multer would have already populated them by that point, so validate/
 * branchGuard/shiftGuard/the handler itself are exercised for real.
 */
function skipMulter(handlers: Middleware[]): Middleware[] {
  return [...handlers.slice(0, 4), ...handlers.slice(5)];
}

describe('POST /payment-proof', () => {
  it('rejects an invalid capture type before reaching the service — 422', async () => {
    const handlers = skipMulter(getRouteHandlers(transactionsRouter, 'post', '/payment-proof'));
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('x'), originalname: 'proof.jpg' },
      body: { branch_id: BRANCH_1, shift_id: SHIFT_1, type: 'not_a_real_type' },
    } as never);
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(transactionsService.uploadPaymentProof).not.toHaveBeenCalled();
  });

  it('returns 422 IMAGE_REQUIRED when no file was attached', async () => {
    const handlers = skipMulter(getRouteHandlers(transactionsRouter, 'post', '/payment-proof'));
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      body: { branch_id: BRANCH_1, shift_id: SHIFT_1, type: 'live_capture' },
    });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'IMAGE_REQUIRED', message: expect.any(String) } }));
    expect(transactionsService.uploadPaymentProof).not.toHaveBeenCalled();
  });

  it('a staff member uploading for a branch they are not assigned to gets 403 from branchGuard', async () => {
    const handlers = skipMulter(getRouteHandlers(transactionsRouter, 'post', '/payment-proof'));
    const token = generateStaffToken(BRANCH_2);
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('x'), originalname: 'proof.jpg' },
      body: { branch_id: BRANCH_1, shift_id: SHIFT_1, type: 'live_capture' },
    } as never);
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(transactionsService.uploadPaymentProof).not.toHaveBeenCalled();
  });

  it('a valid request reaches the service and returns 200 with the storage key', async () => {
    const handlers = skipMulter(getRouteHandlers(transactionsRouter, 'post', '/payment-proof'));
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({
      ...authHeader(token),
      file: { buffer: Buffer.from('x'), originalname: 'proof.jpg' },
      body: { branch_id: BRANCH_1, shift_id: SHIFT_1, type: 'live_capture' },
    } as never);
    const res = mockRes();
    vi.mocked(transactionsService.uploadPaymentProof).mockResolvedValue({
      payment_proof_key: 'branch-1/shift-1/user-1-123.webp',
      payment_proof_type: 'live_capture',
    } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(transactionsService.uploadPaymentProof).toHaveBeenCalledWith(
      { branchId: BRANCH_1, shiftId: SHIFT_1, type: 'live_capture' },
      expect.objectContaining({ originalname: 'proof.jpg' }),
      expect.objectContaining({ role: expect.any(String) }),
    );
  });
});

describe('GET /:transactionId/payment-proof — branch protection', () => {
  it("blocks a supervisor from another branch's transaction — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'get', '/:transactionId/payment-proof');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 } });
    const res = mockRes();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ id: TXN_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(transactionsService.getPaymentProofUrl).not.toHaveBeenCalled();
  });

  it('returns the signed URL for a transaction in the caller branch', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'get', '/:transactionId/payment-proof');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 } });
    const res = mockRes();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ id: TXN_1, branch_id: BRANCH_1 } as never);
    vi.mocked(transactionsService.getPaymentProofUrl).mockResolvedValue({
      payment_proof_url: 'https://signed.example/proof.webp',
      payment_proof_type: 'live_capture',
      uploaded_at: '2026-07-25T10:00:00.000Z',
    } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(transactionsService.getPaymentProofUrl).toHaveBeenCalledWith(TXN_1);
  });
});

describe('POST /:transactionId/void — role guard', () => {
  it('staff cannot void a transaction — 403', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/:transactionId/void');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 }, body: { void_reason: 'x'.repeat(10) } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(transactionsService.voidTransaction).not.toHaveBeenCalled();
  });

  it('supervisor can void a transaction from their own branch', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/:transactionId/void');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 }, body: { void_reason: 'x'.repeat(10) } });
    const res = mockRes();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ id: TXN_1, branch_id: BRANCH_1 } as never);
    vi.mocked(transactionsService.voidTransaction).mockResolvedValue({ id: TXN_1, status: 'voided' } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(transactionsService.voidTransaction).toHaveBeenCalled();
  });
});

describe('POST /:transactionId/refund — role guard', () => {
  it('staff cannot refund a transaction — 403', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/:transactionId/refund');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 }, body: { refund_reason: 'x'.repeat(10) } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(transactionsService.refundTransaction).not.toHaveBeenCalled();
  });
});

describe('GET /:transactionId — branch protection (inline pattern, same as GET /shifts/:shiftId)', () => {
  it("blocks a supervisor from fetching another branch's transaction — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'get', '/:transactionId');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 } });
    const res = mockRes();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ id: TXN_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('allows a super_admin to fetch any transaction regardless of branch — 200', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'get', '/:transactionId');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 } });
    const res = mockRes();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ id: TXN_1, branch_id: BRANCH_2 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET / — list', () => {
  it('a staff member with no branch_id in the query gets 400 BRANCH_ID_REQUIRED from branchGuard', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'get', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: {} });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(transactionsService.listTransactions).not.toHaveBeenCalled();
  });

  it('returns 200 for a staff member requesting their own branch', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'get', '/');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), query: { branch_id: BRANCH_1 } });
    const res = mockRes();
    vi.mocked(transactionsService.listTransactions).mockResolvedValue({ transactions: [], total: 0, page: 1, limit: 25 } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('POST /:transactionId/receipt-printed', () => {
  it('any authenticated user for that branch can mark a receipt printed', async () => {
    const handlers = getRouteHandlers(transactionsRouter, 'post', '/:transactionId/receipt-printed');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { transactionId: TXN_1 } });
    const res = mockRes();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ id: TXN_1, branch_id: BRANCH_1 } as never);
    vi.mocked(transactionsService.markReceiptPrinted).mockResolvedValue(undefined as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { success: true } }));
  });
});
