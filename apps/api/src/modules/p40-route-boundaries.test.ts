import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P40 — authorization boundaries of every route this phase added,
 * run through each route's REAL middleware chain (authenticate, role guard,
 * requirePasswordChange, validate, inline branch checks) against mock
 * req/res, with only services, branch-access lookups and authenticate's
 * revoked-token query mocked. Same technique as settings.router.test.ts.
 */
vi.mock('../lib/prisma.js', () => ({ prisma: { revokedToken: { findFirst: vi.fn() } } }));
vi.mock('../lib/branch-access.js', () => ({
  hasBranchAccess: vi.fn(),
  getAccessibleBranchIds: vi.fn(),
  assertBranchAccess: vi.fn(),
}));
vi.mock('./employees/employees.service.js', () => ({ employeesService: { createEmployee: vi.fn() } }));
vi.mock('./settings/settings.service.js', () => ({
  settingsService: {
    getBranchWorkHours: vi.fn(),
    setBranchWorkHours: vi.fn(),
    clearBranchWorkHours: vi.fn(),
    listBranchWorkHours: vi.fn(),
    updateWorkHoursPolicy: vi.fn(),
  },
}));
vi.mock('./branches/branches.service.js', () => ({ branchesService: { getBranchPresence: vi.fn() } }));
vi.mock('./attendance/attendance.service.js', () => ({ attendanceService: { getForAdmin: vi.fn() } }));
vi.mock('./transactions/transactions.service.js', () => ({
  transactionsService: {
    getTransactionById: vi.fn(),
    getBranchName: vi.fn(),
    exportTransactionsPdf: vi.fn(),
    getPaymentProofUrl: vi.fn(),
    getPaymentProofDownload: vi.fn(),
    getDiscountProofUrl: vi.fn(),
    getDiscountProofDownload: vi.fn(),
  },
}));

const { hasBranchAccess, getAccessibleBranchIds } = await import('../lib/branch-access.js');
const { employeesService } = await import('./employees/employees.service.js');
const { settingsService } = await import('./settings/settings.service.js');
const { branchesService } = await import('./branches/branches.service.js');
const { attendanceService } = await import('./attendance/attendance.service.js');
const { transactionsService } = await import('./transactions/transactions.service.js');
const { employeesRouter } = await import('./employees/employees.router.js');
const { settingsRouter } = await import('./settings/settings.router.js');
const { branchesRouter } = await import('./branches/branches.router.js');
const { attendanceRouter } = await import('./attendance/attendance.router.js');
const { transactionsRouter } = await import('./transactions/transactions.router.js');
const { generateSuperAdminToken, generateSupervisorToken, generateBranchToken } = await import('../test-utils/auth-tokens.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
type MockRes = Response & { statusCode?: number; jsonBody?: unknown };

const BRANCH_1 = randomUUID();
const BRANCH_2 = randomUUID();

function mockReq(token: string, overrides: Partial<Request> = {}): Request {
  return { headers: { authorization: `Bearer ${token}` }, params: {}, query: {}, body: {}, originalUrl: '/api/x', ...overrides } as unknown as Request;
}

function mockRes(): MockRes {
  const res = {} as MockRes;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as unknown as Response['json'];
  res.send = vi.fn(() => res) as unknown as Response['send'];
  res.setHeader = vi.fn(() => res) as unknown as Response['setHeader'];
  return res;
}

function handlers(router: Router, method: string, path: string): Middleware[] {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Middleware }> } };
  const layer = (router as unknown as { stack: RouteLayer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function run(router: Router, method: string, path: string, req: Request): Promise<MockRes> {
  const res = mockRes();
  for (const handler of handlers(router, method, path)) {
    let calledNext = false;
    await handler(req, res, ((error?: unknown) => {
      if (error) throw error;
      calledNext = true;
    }) as NextFunction);
    if (!calledNext) break;
  }
  return res;
}

const admin = () => generateSuperAdminToken();
const supervisor = () => generateSupervisorToken([BRANCH_1]);
const branchAccount = () => generateBranchToken(BRANCH_1);

const SUPERVISOR_BODY = {
  first_name: 'Ana',
  last_name: 'Reyes',
  email: 'ana@example.com',
  initial_password: 'Str0ng!Pass',
  employment_type: 'regular',
  branch_ids: [BRANCH_1],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasBranchAccess).mockImplementation(async (actor, branchId) => actor.role === 'super_admin' || branchId === BRANCH_1);
  vi.mocked(getAccessibleBranchIds).mockImplementation(async (actor) => (actor.role === 'super_admin' ? 'all' : [BRANCH_1]));
});

describe('POST /api/employees/supervisors (supervisor-only provisioning)', () => {
  it('creates a supervisor for Super Admin', async () => {
    vi.mocked(employeesService.createEmployee).mockResolvedValue({ id: 'new' } as never);
    const res = await run(employeesRouter, 'post', '/supervisors', mockReq(admin(), { body: { ...SUPERVISOR_BODY, role: 'supervisor' } }));
    expect(res.statusCode).toBe(201);
    expect(employeesService.createEmployee).toHaveBeenCalledWith(expect.objectContaining({ role: 'supervisor' }), expect.anything(), null);
  });

  it.each(['staff', 'branch', 'super_admin'])('rejects role %s server-side even for Super Admin', async (role) => {
    const res = await run(employeesRouter, 'post', '/supervisors', mockReq(admin(), { body: { ...SUPERVISOR_BODY, role, position: 'Cashier' } }));
    expect(res.statusCode).toBe(422);
    expect(employeesService.createEmployee).not.toHaveBeenCalled();
  });

  it('refuses a supervisor caller', async () => {
    const res = await run(employeesRouter, 'post', '/supervisors', mockReq(supervisor(), { body: { ...SUPERVISOR_BODY, role: 'supervisor' } }));
    expect(res.statusCode).toBe(403);
    expect(employeesService.createEmployee).not.toHaveBeenCalled();
  });
});

describe('Work Hours per branch', () => {
  it('lets a supervisor save hours for an assigned branch', async () => {
    vi.mocked(settingsService.setBranchWorkHours).mockResolvedValue({} as never);
    const res = await run(
      settingsRouter,
      'put',
      '/work-hours/branches/:branchId',
      mockReq(supervisor(), { params: { branchId: BRANCH_1 }, body: { regularHours: 9 } }),
    );
    expect(res.statusCode).toBe(200);
    expect(settingsService.setBranchWorkHours).toHaveBeenCalledWith(BRANCH_1, { regularHours: 9 }, expect.anything(), null);
  });

  it('refuses a branch the supervisor is not assigned to', async () => {
    const res = await run(
      settingsRouter,
      'put',
      '/work-hours/branches/:branchId',
      mockReq(supervisor(), { params: { branchId: BRANCH_2 }, body: { regularHours: 9 } }),
    );
    expect(res.statusCode).toBe(403);
    expect(settingsService.setBranchWorkHours).not.toHaveBeenCalled();
  });

  it('refuses a branch account entirely and keeps the cross-branch list Super Admin only', async () => {
    const put = await run(settingsRouter, 'put', '/work-hours/branches/:branchId', mockReq(branchAccount(), { params: { branchId: BRANCH_1 }, body: { regularHours: 9 } }));
    expect(put.statusCode).toBe(403);
    const list = await run(settingsRouter, 'get', '/work-hours/branches', mockReq(supervisor()));
    expect(list.statusCode).toBe(403);
  });

  // POS-PERF-P40R — the global default stays Super Admin only.
  it('refuses a supervisor writing the global default, and lets Super Admin do it', async () => {
    const denied = await run(settingsRouter, 'put', '/work-hours', mockReq(supervisor(), { body: { regularHours: 6 } }));
    expect(denied.statusCode).toBe(403);
    expect(settingsService.updateWorkHoursPolicy).not.toHaveBeenCalled();

    vi.mocked(settingsService.updateWorkHoursPolicy).mockResolvedValue({ regularHours: 6 } as never);
    const allowed = await run(settingsRouter, 'put', '/work-hours', mockReq(admin(), { body: { regularHours: 6 } }));
    expect(allowed.statusCode).toBe(200);
  });

  it('strips anything but regularHours from a supervisor branch write, so it cannot reach the global row', async () => {
    vi.mocked(settingsService.setBranchWorkHours).mockResolvedValue({} as never);
    const res = await run(
      settingsRouter,
      'put',
      '/work-hours/branches/:branchId',
      mockReq(supervisor(), { params: { branchId: BRANCH_1 }, body: { regularHours: 9, key: 'work_hours_policy', scope: 'global' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(settingsService.setBranchWorkHours).toHaveBeenCalledWith(BRANCH_1, { regularHours: 9 }, expect.anything(), null);
    expect(settingsService.updateWorkHoursPolicy).not.toHaveBeenCalled();
  });

  it('rejects out-of-range hours before touching the service', async () => {
    const res = await run(settingsRouter, 'put', '/work-hours/branches/:branchId', mockReq(admin(), { params: { branchId: BRANCH_1 }, body: { regularHours: 0 } }));
    expect(res.statusCode).toBe(422);
    expect(settingsService.setBranchWorkHours).not.toHaveBeenCalled();
  });
});

describe('Admin-only reads', () => {
  it('branch presence is Super Admin only', async () => {
    vi.mocked(branchesService.getBranchPresence).mockResolvedValue({ available: true, checked_at: '', branches: [] });
    expect((await run(branchesRouter, 'get', '/presence', mockReq(supervisor()))).statusCode).toBe(403);
    expect((await run(branchesRouter, 'get', '/presence', mockReq(admin()))).statusCode).toBe(200);
  });

  it('cross-branch attendance is Super Admin only', async () => {
    vi.mocked(attendanceService.getForAdmin).mockResolvedValue({ records: [] } as never);
    expect((await run(attendanceRouter, 'get', '/admin', mockReq(supervisor()))).statusCode).toBe(403);
    const ok = await run(attendanceRouter, 'get', '/admin', mockReq(admin(), { query: { supervisor_id: randomUUID(), open_only: 'true' } }));
    expect(ok.statusCode).toBe(200);
    expect(attendanceService.getForAdmin).toHaveBeenCalledWith(expect.objectContaining({ openOnly: true }), expect.anything());
  });
});

describe('GET /api/transactions/export/pdf', () => {
  beforeEach(() => {
    vi.mocked(transactionsService.exportTransactionsPdf).mockResolvedValue({ buffer: Buffer.from('%PDF-1.3'), filename: 'transactions-filtered-x.pdf', rowCount: 1 });
  });

  it('refuses branch accounts', async () => {
    const res = await run(transactionsRouter, 'get', '/export/pdf', mockReq(branchAccount(), { query: { branch_id: BRANCH_1 } }));
    expect(res.statusCode).toBe(403);
    expect(transactionsService.exportTransactionsPdf).not.toHaveBeenCalled();
  });

  it('refuses a supervisor asking for a branch they cannot access', async () => {
    const res = await run(transactionsRouter, 'get', '/export/pdf', mockReq(supervisor(), { query: { branch_id: BRANCH_2 } }));
    expect(res.statusCode).toBe(403);
    expect(transactionsService.exportTransactionsPdf).not.toHaveBeenCalled();
  });

  it('limits a supervisor export without a branch to their accessible branches', async () => {
    const res = await run(transactionsRouter, 'get', '/export/pdf', mockReq(supervisor(), { query: { date_from: '2026-10-27', date_to: '2026-10-27' } }));
    expect(res.statusCode).toBe(200);
    expect(transactionsService.exportTransactionsPdf).toHaveBeenCalledWith(
      expect.objectContaining({ branchIds: [BRANCH_1], dateFrom: '2026-10-27' }),
      expect.anything(),
      expect.objectContaining({ role: 'supervisor' }),
      null,
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="transactions-filtered-x.pdf"');
  });

  it('checks a single transaction against its own branch', async () => {
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ branch_id: BRANCH_2 } as never);
    const res = await run(transactionsRouter, 'get', '/export/pdf', mockReq(supervisor(), { query: { transaction_id: randomUUID() } }));
    expect(res.statusCode).toBe(403);
  });
});

describe('proof download', () => {
  it('returns a fresh download URL only with ?download=1 and only within branch scope', async () => {
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ branch_id: BRANCH_1 } as never);
    vi.mocked(transactionsService.getPaymentProofDownload).mockResolvedValue({ download_url: 'u', filename: 'f.webp', expires_in_seconds: 300 });
    const ok = await run(transactionsRouter, 'get', '/:transactionId/payment-proof', mockReq(supervisor(), { params: { transactionId: 't1' }, query: { download: '1' } }));
    expect(ok.statusCode).toBe(200);
    expect(transactionsService.getPaymentProofDownload).toHaveBeenCalledWith('t1');
    expect(transactionsService.getPaymentProofUrl).not.toHaveBeenCalled();

    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ branch_id: BRANCH_2 } as never);
    const denied = await run(transactionsRouter, 'get', '/:transactionId/discount-proof', mockReq(supervisor(), { params: { transactionId: 't2' }, query: { download: '1' } }));
    expect(denied.statusCode).toBe(403);
    expect(transactionsService.getDiscountProofDownload).not.toHaveBeenCalled();
  });

  // POS-PERF-P40R — a permanently missing file gets its own status; the
  // branch check still runs first, so an outsider learns nothing about it.
  it('answers 410 PROOF_FILE_MISSING for an authorized caller and 403 for anyone else', async () => {
    const { TransactionError } = await import('./transactions/transactions.types.js');
    const missing = new TransactionError('PROOF_FILE_MISSING', 'This photo is no longer in storage, so it cannot be shown or downloaded.', 410);
    vi.mocked(transactionsService.getPaymentProofUrl).mockRejectedValue(missing);
    vi.mocked(transactionsService.getPaymentProofDownload).mockRejectedValue(missing);

    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ branch_id: BRANCH_1 } as never);
    const view = await run(transactionsRouter, 'get', '/:transactionId/payment-proof', mockReq(supervisor(), { params: { transactionId: 't1' } }));
    expect(view.statusCode).toBe(410);
    expect(view.jsonBody).toMatchObject({ data: null, error: { code: 'PROOF_FILE_MISSING' } });
    const download = await run(transactionsRouter, 'get', '/:transactionId/payment-proof', mockReq(supervisor(), { params: { transactionId: 't1' }, query: { download: '1' } }));
    expect(download.statusCode).toBe(410);

    vi.mocked(transactionsService.getPaymentProofUrl).mockClear();
    vi.mocked(transactionsService.getTransactionById).mockResolvedValue({ branch_id: BRANCH_2 } as never);
    const outsider = await run(transactionsRouter, 'get', '/:transactionId/payment-proof', mockReq(supervisor(), { params: { transactionId: 't2' } }));
    expect(outsider.statusCode).toBe(403);
    expect(outsider.jsonBody).toEqual({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
    expect(transactionsService.getPaymentProofUrl).not.toHaveBeenCalled();
  });
});
