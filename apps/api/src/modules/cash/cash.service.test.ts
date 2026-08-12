import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { shiftResponseSchema, shiftCloseResponseSchema } from '@potato-corner/shared';

vi.mock('../../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('./cash.repository.js', () => ({
  cashRepository: {
    findActiveShiftByBranch: vi.fn(),
    findShiftById: vi.fn(),
    findUserById: vi.fn(),
    createShift: vi.fn(),
    createAutoShift: vi.fn(),
    sumTransactionsForShift: vi.fn(),
    sumTransactionCountsForShift: vi.fn(),
    sumCashRefundsProcessedDuringShift: vi.fn(),
    countAnyTransactionsForShift: vi.fn(),
    closeShift: vi.fn(),
    approveVariance: vi.fn(),
    voidShift: vi.fn(),
    listShifts: vi.fn(),
    listReviewsForShift: vi.fn(),
    findReview: vi.fn(),
    submitReview: vi.fn(),
    listPendingReviews: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// closeShift now opens its own transaction (Task 209.37 #3) so the
// sales-total reads and the close write share one snapshot — cashRepository
// itself is fully mocked below, so passing `tx` through to its calls doesn't
// depend on tx's real shape, only that it's the SAME object every call sees
// and is distinct from the root `prisma` client (asserted below — a real tx
// must never leak the un-scoped root client). closeShift now also takes a
// branch-scoped advisory lock directly on `tx.$executeRaw` (Task 209.41 Part
// H), so this stand-in tx client needs its own working $executeRaw, separate
// from root prisma's. Tests that need to assert on tx.$executeRaw capture
// the tx object from a cashRepository call's arguments (e.g.
// sumTransactionsForShift's 2nd arg) rather than importing it directly,
// since it isn't part of the real prisma module's exported shape.
vi.mock('../../lib/prisma.js', () => {
  const txClient = { $executeRaw: vi.fn().mockResolvedValue(undefined) };
  const prismaMock = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(txClient)),
  };
  return { prisma: prismaMock };
});

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../attendance/attendance.repository.js', () => ({
  attendanceRepository: {
    findActiveRecord: vi.fn(),
  },
}));

const { cashRepository } = await import('./cash.repository.js');
const { attendanceRepository } = await import('../attendance/attendance.repository.js');
const { notifyBranch, notifySuperAdmin } = await import('../../lib/notify.js');
const { enqueueNotification } = await import('../../queues/notification.queue.js');
const { prisma } = await import('../../lib/prisma.js');
const { cashService } = await import('./cash.service.js');

const SUPERVISOR = { id: 'supervisor-1', role: 'supervisor' };
const SUPER_ADMIN = { id: 'admin-1', role: 'super_admin' };
// Task 209.55B fixtures: a Branch Account's own JWT id is distinct from any
// employee id — its authorization comes entirely from branchIds, scoped to
// its one assigned branch (matching the jwtPayloadSchema `branch` variant's
// `branch_ids: z.array(z.uuid()).length(1)`).
const BRANCH = { id: 'branch-account-1', role: 'branch', branchIds: ['branch-1'] };
const FOREIGN_BRANCH = { id: 'branch-account-2', role: 'branch', branchIds: ['branch-2'] };
const STAFF = { id: 'employee-1', role: 'staff' };

function decimal(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

/** cashRepository.closeShift's real `computed` param is plain numbers, but the row it resolves to (like every Prisma row) carries Decimal-like fields — wraps the ones toShiftResponse expects to call .toNumber() on. */
function asShiftRow(computed: Record<string, unknown>) {
  const decimalFields = ['closingCashAmount', 'expectedClosingCash', 'cashVariance', 'cashSalesTotal', 'gcashSalesTotal', 'mayaSalesTotal', 'otherSalesTotal', 'grossSalesTotal', 'totalDiscountAmount'];
  const wrapped: Record<string, unknown> = { ...computed };
  for (const field of decimalFields) {
    if (typeof wrapped[field] === 'number') wrapped[field] = decimal(wrapped[field] as number);
  }
  return shiftRow(wrapped);
}

function shiftRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'shift-1',
    branchId: 'branch-1',
    cashierId: 'cashier-1',
    openedBy: 'supervisor-1',
    closedBy: null,
    status: 'active',
    openingCashAmount: decimal(1000),
    closingCashAmount: null,
    expectedClosingCash: null,
    cashVariance: null,
    varianceApproved: null,
    varianceExplanation: null,
    varianceApprovedBy: null,
    varianceApprovalReason: null,
    cashSalesTotal: decimal(0),
    gcashSalesTotal: decimal(0),
    mayaSalesTotal: decimal(0),
    otherSalesTotal: decimal(0),
    grossSalesTotal: decimal(0),
    transactionCount: 0,
    cashSalesCount: 0,
    gcashSalesCount: 0,
    mayaSalesCount: 0,
    otherSalesCount: 0,
    voidedCount: 0,
    refundedCount: 0,
    totalTransactionCount: 0,
    totalDiscountAmount: decimal(0),
    pwdScTransactionCount: 0,
    shiftNotes: null,
    startedAt: new Date('2026-01-01T08:00:00.000Z'),
    closedAt: null,
    denominations: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the cashier is already timed in at branch-1 — most openShift
  // tests aren't exercising the attendance-link guard (§6), only the
  // dedicated ATTENDANCE_REQUIRED test below overrides this.
  vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue({ branchId: 'branch-1' } as never);
  // Task 209.41 — default to "no cash refunds during this shift" so every
  // pre-existing closeShift/getShiftSummary fixture (which predates this
  // term) keeps computing the same expected_cash/expectedClosingCash it did
  // before; the dedicated describe block below overrides this per-test.
  vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(0));
});

describe('cashService.openShift', () => {
  it('rejects with 409 SHIFT_ALREADY_OPEN when the branch already has an active shift', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(shiftRow() as never);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN', statusCode: 409 });
    expect(cashRepository.createShift).not.toHaveBeenCalled();
  });

  it('rejects with 400 STARTING_CASH_MISMATCH when starting_cash does not equal the denomination sum', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 999, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'STARTING_CASH_MISMATCH', statusCode: 400 });
    expect(cashRepository.createShift).not.toHaveBeenCalled();
  });

  it('rejects with 404 CASHIER_NOT_FOUND when the cashier does not exist or is inactive', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(cashRepository.findUserById).mockResolvedValue(null);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'CASHIER_NOT_FOUND', statusCode: 404 });
  });

  it('rejects with 409 ATTENDANCE_REQUIRED when the cashier has no active attendance record at this branch (§6 attendance-shift link)', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue(null);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_REQUIRED', statusCode: 409 });
    expect(cashRepository.createShift).not.toHaveBeenCalled();
  });

  it('rejects with 409 ATTENDANCE_REQUIRED when the cashier is timed in at a different branch', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue({ branchId: 'branch-2' } as never);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_REQUIRED', statusCode: 409 });
  });

  it('creates the shift when there is no active shift, the totals match, and the cashier is active', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(cashRepository.findUserById).mockResolvedValue({ id: 'cashier-1', isActive: true } as never);
    vi.mocked(cashRepository.createShift).mockResolvedValue(shiftRow() as never);

    const result = await cashService.openShift(
      { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
      null,
    );

    expect(result.status).toBe('active');
    expect(cashRepository.createShift).toHaveBeenCalled();
  });

  it('broadcasts SHIFT_OPENED to the branch room and Super Admin with a payload matching shiftResponseSchema', async () => {
    const shiftId = randomUUID();
    const branchId = randomUUID();
    const cashierId = randomUUID();
    const openedBy = randomUUID();
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(attendanceRepository.findActiveRecord).mockResolvedValue({ branchId } as never);
    vi.mocked(cashRepository.findUserById).mockResolvedValue({ id: cashierId, isActive: true } as never);
    vi.mocked(cashRepository.createShift).mockResolvedValue(shiftRow({ id: shiftId, branchId, cashierId, openedBy }) as never);

    const result = await cashService.openShift(
      { branchId, cashierId, openedBy, startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
      null,
    );

    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'cash:shift_opened', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:shift_opened', result);
    expect(shiftResponseSchema.safeParse(result).success).toBe(true);
  });

  it('converts a P2002 race on createShift (two terminals manually opening at once) into 409 SHIFT_ALREADY_OPEN instead of a raw 500', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(cashRepository.findUserById).mockResolvedValue({ id: 'cashier-1', isActive: true } as never);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`branch_id`)', { code: 'P2002', clientVersion: '5.22.0' });
    vi.mocked(cashRepository.createShift).mockRejectedValue(p2002);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN', statusCode: 409 });
  });

  it('rethrows non-P2002 errors from createShift untouched', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(cashRepository.findUserById).mockResolvedValue({ id: 'cashier-1', isActive: true } as never);
    const dbError = new Error('connection lost');
    vi.mocked(cashRepository.createShift).mockRejectedValue(dbError);

    await expect(
      cashService.openShift(
        { branchId: 'branch-1', cashierId: 'cashier-1', openedBy: 'supervisor-1', startingCash: 1000, denominations: [{ denomination: 1000, quantity: 1 }] },
        null,
      ),
    ).rejects.toBe(dbError);
  });
});

describe('cashService.autoOpenShift', () => {
  it('creates a new auto shift when the branch has no active shift', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    vi.mocked(cashRepository.createAutoShift).mockResolvedValue(shiftRow({ cashierId: 'cashier-1' }) as never);

    const result = await cashService.autoOpenShift({ branchId: 'branch-1', cashierId: 'cashier-1' }, null);

    expect(cashRepository.createAutoShift).toHaveBeenCalledWith({ branchId: 'branch-1', cashierId: 'cashier-1' });
    expect(result.cashier_id).toBe('cashier-1');
  });

  it('reuses another cashier\'s already-open branch shift instead of creating a new one (Task 103)', async () => {
    const existing = shiftRow({ id: 'shift-owned-by-other', cashierId: 'other-cashier' });
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(existing as never);

    const result = await cashService.autoOpenShift({ branchId: 'branch-1', cashierId: 'cashier-1' }, null);

    expect(cashRepository.createAutoShift).not.toHaveBeenCalled();
    expect(result.id).toBe('shift-owned-by-other');
  });

  it('recovers from a P2002 race (two terminals auto-opening at once) by re-reading the branch shift the other request won', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValueOnce(null).mockResolvedValueOnce(shiftRow({ id: 'shift-race-winner', cashierId: 'other-cashier' }) as never);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`branch_id`)', { code: 'P2002', clientVersion: '5.22.0' });
    vi.mocked(cashRepository.createAutoShift).mockRejectedValue(p2002);

    const result = await cashService.autoOpenShift({ branchId: 'branch-1', cashierId: 'cashier-1' }, null);

    expect(result.id).toBe('shift-race-winner');
  });

  it('rethrows a P2002 if the branch still has no active shift on re-read (not the concurrency case)', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' });
    vi.mocked(cashRepository.createAutoShift).mockRejectedValue(p2002);

    await expect(cashService.autoOpenShift({ branchId: 'branch-1', cashierId: 'cashier-1' }, null)).rejects.toBe(p2002);
  });

  it('rethrows non-P2002 errors from createAutoShift untouched', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);
    const dbError = new Error('connection lost');
    vi.mocked(cashRepository.createAutoShift).mockRejectedValue(dbError);

    await expect(cashService.autoOpenShift({ branchId: 'branch-1', cashierId: 'cashier-1' }, null)).rejects.toBe(dbError);
  });
});

describe('cashService.getCurrentShift', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when no shift is active at the branch', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(null);

    await expect(cashService.getCurrentShift('branch-1')).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('overlays a live sales total for an active shift instead of the stale persisted 0', async () => {
    vi.mocked(cashRepository.findActiveShiftByBranch).mockResolvedValue(shiftRow({ status: 'active' }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(250),
      gcashSalesTotal: new Prisma.Decimal(75),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 6,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 4,
      gcashSalesCount: 1,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 1,
      totalTransactionCount: 6,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });

    const result = await cashService.getCurrentShift('branch-1');

    expect(result.cash_sales_total).toBe(250);
    expect(result.gcash_sales_total).toBe(75);
    expect(result.transaction_count).toBe(6);
    // Task 209.55A regression — cash_sales_count (and the other close-time-
    // only counts) used to stay at the Shift row's persisted 0 for an active
    // shift even though the totals above were already live-overlaid;
    // reproduced against a real QA shift (cash_sales_total=3445,
    // cash_sales_count=0) via GET /api/cash/current.
    expect(result.cash_sales_count).toBe(4);
    expect(result.gcash_sales_count).toBe(1);
    expect(result.refunded_count).toBe(1);
  });
});

describe('cashService.getShiftById', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(cashService.getShiftById('missing')).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('does not overlay a live sales total for an already-closed shift — its persisted totals are final', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'closed', cashSalesTotal: decimal(500) }) as never);

    const result = await cashService.getShiftById('shift-1');

    expect(result.cash_sales_total).toBe(500);
    expect(cashRepository.sumTransactionsForShift).not.toHaveBeenCalled();
  });
});

describe('cashService.closeShift', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(cashService.closeShift('missing', { denominations: [] }, SUPERVISOR, null)).rejects.toMatchObject({
      code: 'SHIFT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('rejects with 409 SHIFT_NOT_OPEN when the shift is already closed', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'closed' }) as never);

    await expect(cashService.closeShift('shift-1', { denominations: [] }, SUPERVISOR, null)).rejects.toMatchObject({
      code: 'SHIFT_NOT_OPEN',
      statusCode: 409,
    });
  });

  it('rejects with 403 SHIFT_UNAUTHORIZED_CLOSE when a different supervisor than the opener tries to close it', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openedBy: 'someone-else' }) as never);

    await expect(cashService.closeShift('shift-1', { denominations: [] }, SUPERVISOR, null)).rejects.toMatchObject({
      code: 'SHIFT_UNAUTHORIZED_CLOSE',
      statusCode: 403,
    });
  });

  it('allows a super_admin to close a shift opened by a different supervisor', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openedBy: 'someone-else' }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockResolvedValue(shiftRow({ status: 'closed' }) as never);

    await expect(
      cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPER_ADMIN, null),
    ).resolves.toMatchObject({ status: 'closed' });
  });

  // Task 209.55B — a Branch Account operating through a selected/embedded
  // employee auto-opens the shift under that employee's id (openedBy !==
  // the Branch Account's own JWT id), but still operationally owns every
  // shift at its own branch.
  function mockSuccessfulClose() {
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockResolvedValue(shiftRow({ status: 'closed' }) as never);
  }

  it('allows a Branch Account to close a shift its own selected employee opened (Task 209.55B)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId: 'branch-1', openedBy: 'embedded-employee-1' }) as never);
    mockSuccessfulClose();

    await expect(
      cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, BRANCH, null),
    ).resolves.toMatchObject({ status: 'closed' });
  });

  it('rejects with 403 SHIFT_UNAUTHORIZED_CLOSE when a Branch Account attempts to close a shift belonging to a different branch (Task 209.55B)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId: 'branch-2', openedBy: 'foreign-employee-1' }) as never);

    await expect(cashService.closeShift('shift-1', { denominations: [] }, BRANCH, null)).rejects.toMatchObject({
      code: 'SHIFT_UNAUTHORIZED_CLOSE',
      statusCode: 403,
    });
    expect(cashRepository.closeShift).not.toHaveBeenCalled();
  });

  it('rejects with 403 SHIFT_UNAUTHORIZED_CLOSE when a foreign branch account (matching branchIds elsewhere) still does not match this shift\'s branch (Task 209.55B)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId: 'branch-1', openedBy: 'embedded-employee-1' }) as never);

    await expect(cashService.closeShift('shift-1', { denominations: [] }, FOREIGN_BRANCH, null)).rejects.toMatchObject({
      code: 'SHIFT_UNAUTHORIZED_CLOSE',
      statusCode: 403,
    });
  });

  it('allows staff to close a shift they opened themselves (unchanged existing behavior)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openedBy: STAFF.id }) as never);
    mockSuccessfulClose();

    await expect(
      cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, STAFF, null),
    ).resolves.toMatchObject({ status: 'closed' });
  });

  it('rejects with 403 SHIFT_UNAUTHORIZED_CLOSE when staff attempts to close another employee\'s shift (Task 209.55B)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openedBy: 'someone-else' }) as never);

    await expect(cashService.closeShift('shift-1', { denominations: [] }, STAFF, null)).rejects.toMatchObject({
      code: 'SHIFT_UNAUTHORIZED_CLOSE',
      statusCode: 403,
    });
  });

  it('broadcasts SHIFT_CLOSED to the branch room and Super Admin with a payload matching shiftCloseResponseSchema', async () => {
    const shiftId = randomUUID();
    const branchId = randomUUID();
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ id: shiftId, branchId, openedBy: randomUUID() }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockResolvedValue(
      shiftRow({ id: shiftId, branchId, cashierId: randomUUID(), openedBy: randomUUID(), closedBy: randomUUID(), status: 'closed' }) as never,
    );

    const result = await cashService.closeShift(shiftId, { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPER_ADMIN, null);

    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'cash:shift_closed', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:shift_closed', result);
    expect(shiftCloseResponseSchema.safeParse(result).success).toBe(true);
  });

  it('computes expected_closing_cash from opening cash plus completed cash sales only (excludes gcash)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(500),
      gcashSalesTotal: new Prisma.Decimal(300),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 4,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    const result = await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }] }, SUPERVISOR, null);

    expect(result.expected_closing_cash).toBe(1500);
    expect(cashRepository.closeShift).toHaveBeenCalledWith(
      'shift-1',
      expect.anything(),
      expect.objectContaining({ expectedClosingCash: 1500, cashSalesTotal: 500, gcashSalesTotal: 300, transactionCount: 4 }),
      expect.anything(),
    );
  });

  it('reads sales totals and writes the close inside the same transaction client, never through root prisma', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sumTx = vi.mocked(cashRepository.sumTransactionsForShift).mock.calls[0]?.[1];
    const countsTx = vi.mocked(cashRepository.sumTransactionCountsForShift).mock.calls[0]?.[1];
    const closeTx = vi.mocked(cashRepository.closeShift).mock.calls[0]?.[3];

    expect(sumTx).toBeDefined();
    expect(sumTx).toBe(countsTx);
    expect(sumTx).toBe(closeTx);
    expect(sumTx).not.toBe(prisma);
  });

  it('computes and persists all 7 summary count/total fields, and returns them on the shift response plus in `summary`', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(500),
      gcashSalesTotal: new Prisma.Decimal(300),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 4,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 3,
      gcashSalesCount: 2,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 1,
      refundedCount: 1,
      totalTransactionCount: 7,
      totalDiscountAmount: 40,
      pwdScTransactionCount: 2,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) =>
      Promise.resolve({
        ...asShiftRow(computed),
        cashSalesCount: computed.cashSalesCount,
        gcashSalesCount: computed.gcashSalesCount,
        voidedCount: computed.voidedCount,
        refundedCount: computed.refundedCount,
        totalTransactionCount: computed.totalTransactionCount,
        totalDiscountAmount: decimal(computed.totalDiscountAmount as number),
        pwdScTransactionCount: computed.pwdScTransactionCount,
      } as never),
    );

    const result = await cashService.closeShift(
      'shift-1',
      { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }] },
      SUPERVISOR,
      null,
    );

    expect(cashRepository.closeShift).toHaveBeenCalledWith(
      'shift-1',
      expect.anything(),
      expect.objectContaining({
        cashSalesCount: 3,
        gcashSalesCount: 2,
        voidedCount: 1,
        refundedCount: 1,
        totalTransactionCount: 7,
        totalDiscountAmount: 40,
        pwdScTransactionCount: 2,
      }),
      expect.anything(),
    );
    expect(result.cash_sales_count).toBe(3);
    expect(result.gcash_sales_count).toBe(2);
    expect(result.total_transaction_count).toBe(7);
    expect(result.summary).toMatchObject({
      cash_sales_total: 500,
      gcash_sales_total: 300,
      total_sales: 800,
      cash_sales_count: 3,
      gcash_sales_count: 2,
      total_transaction_count: 7,
      voided_count: 1,
      refunded_count: 1,
      total_discount_amount: 40,
      pwd_sc_transaction_count: 2,
      expected_cash: 1500,
      actual_cash: 1500,
      variance_status: 'AUTO_APPROVED',
    });
  });

  it('auto-approves and closes when the counted cash exactly matches expected cash (zero-tolerance default)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    const result = await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);

    expect(result.status).toBe('closed');
    expect(result.variance_approved).toBe(true);
  });

  it('rejects with 400 VARIANCE_EXPLANATION_REQUIRED when counted cash differs and no explanation was given', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });

    await expect(
      cashService.closeShift('shift-1', { denominations: [{ denomination: 500, quantity: 1 }] }, SUPERVISOR, null),
    ).rejects.toMatchObject({ code: 'VARIANCE_EXPLANATION_REQUIRED', statusCode: 400 });
    expect(cashRepository.closeShift).not.toHaveBeenCalled();
  });

  it('flags the shift for review (status "flagged", variance_approved null) when a variance explanation is provided', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    const result = await cashService.closeShift(
      'shift-1',
      { denominations: [{ denomination: 500, quantity: 1 }], varianceExplanation: 'x'.repeat(50) },
      SUPERVISOR,
      null,
    );

    expect(result.status).toBe('flagged');
    expect(result.variance_approved).toBeNull();
  });

  it('broadcasts CASH_VARIANCE_FLAGGED to the branch room and Super Admin when the shift is flagged', async () => {
    const branchId = randomUUID();
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId, openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0, gcashSalesCount: 0, mayaSalesCount: 0, otherSalesCount: 0, voidedCount: 0, refundedCount: 0,
      totalTransactionCount: 0, totalDiscountAmount: 0, pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) =>
      Promise.resolve(asShiftRow({ ...computed, branchId, status: 'flagged' }) as never),
    );

    await cashService.closeShift(
      'shift-1',
      { denominations: [{ denomination: 500, quantity: 1 }], varianceExplanation: 'x'.repeat(50) },
      SUPERVISOR,
      null,
    );

    expect(notifyBranch).toHaveBeenCalledWith(
      branchId,
      'cash:variance_flagged',
      expect.objectContaining({ shiftId: 'shift-1', branchId, flaggedBy: SUPERVISOR.id }),
    );
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:variance_flagged', expect.objectContaining({ shiftId: 'shift-1' }));
    expect(enqueueNotification).toHaveBeenCalledWith(
      'cash_variance_flagged',
      expect.objectContaining({ type: 'cash_variance_flagged', shiftId: 'shift-1', branchId, flaggedBy: SUPERVISOR.id }),
    );
  });

  it('does not enqueue a notification when the shift closes cleanly (no variance)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) =>
      Promise.resolve(asShiftRow({ ...computed, status: 'closed' }) as never),
    );

    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);

    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('does not broadcast CASH_VARIANCE_FLAGGED when the shift closes cleanly (no variance)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0, gcashSalesCount: 0, mayaSalesCount: 0, otherSalesCount: 0, voidedCount: 0, refundedCount: 0,
      totalTransactionCount: 0, totalDiscountAmount: 0, pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);

    expect(notifyBranch).not.toHaveBeenCalledWith(expect.anything(), 'cash:variance_flagged', expect.anything());
  });

  // Task 209.52A — the Postgres advisory lock (branchShiftLockId) is what
  // actually serializes two real concurrent closeShift calls; that can't be
  // observed through this fully-mocked repository/prisma. What's under test
  // here is the service-level consequence once the lock has done its job:
  // call A's pre-lock check and call B's pre-lock check can both observe
  // 'active' (that's the race), but only one of them can win the lock and
  // commit first. The loser's re-read *through the same tx client*, taken
  // immediately after it finally acquires the lock, must see call A's
  // already-'closed' status and abort — never reaching cashRepository.closeShift
  // a second time.
  it('rejects the losing side of a concurrent close race with 409 SHIFT_NOT_OPEN once the lock reveals the shift was already closed (Task 209.52A)', async () => {
    const activeShift = shiftRow({ status: 'active' });
    const closedShift = shiftRow({ status: 'closed', closedBy: SUPERVISOR.id });

    vi.mocked(cashRepository.findShiftById)
      .mockResolvedValueOnce(activeShift as never) // call A — pre-lock check
      .mockResolvedValueOnce(activeShift as never) // call A — post-lock re-check
      .mockResolvedValueOnce(activeShift as never) // call B — pre-lock check (raced ahead of A's commit)
      .mockResolvedValueOnce(closedShift as never); // call B — post-lock re-check (A has since committed)
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0, gcashSalesCount: 0, mayaSalesCount: 0, otherSalesCount: 0, voidedCount: 0, refundedCount: 0,
      totalTransactionCount: 0, totalDiscountAmount: 0, pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    const denominations = [{ denomination: 1000, quantity: 1 }];
    const resultA = await cashService.closeShift('shift-1', { denominations }, SUPERVISOR, null);
    await expect(cashService.closeShift('shift-1', { denominations }, SUPERVISOR, null)).rejects.toMatchObject({
      code: 'SHIFT_NOT_OPEN',
      statusCode: 409,
    });

    expect(resultA.status).toBe('closed');
    // Only call A's close reached the write — no double-close, and therefore
    // no duplicate ShiftCashDenomination rows and no second overwrite of
    // expectedClosingCash/closingCashAmount/cashVariance.
    expect(cashRepository.closeShift).toHaveBeenCalledTimes(1);
  });
});

// Task 209.41 Parts E/F/G/H — CASH refunds paid out of this shift's drawer
// (for sales belonging to an earlier, already-closed shift) reduce
// expectedClosingCash at close time. A same-shift sale+refund must not
// double-subtract — that's proven at the repository layer (see
// cash.repository.test.ts's sumCashRefundsProcessedDuringShift describe,
// which asserts the shiftId-exclusion clause); here we prove the service
// correctly folds whatever the repository returns into the persisted
// formula, and never touches the original (earlier) shift to do it.
describe('cashService.closeShift — CASH refund processing-shift accounting (Task 209.41)', () => {
  function baseMocks() {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(500),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 1,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 1,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 1,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));
  }

  it('subtracts a prior-shift cash refund from expectedClosingCash: opening 1000 + cash sales 500 - refunds 200 = 1300 (Part E, Part K #9)', async () => {
    baseMocks();
    vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(200));

    const result = await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 300, quantity: 1 }] }, SUPERVISOR, null);

    expect(result.expected_closing_cash).toBe(1300);
    expect(cashRepository.closeShift).toHaveBeenCalledWith(
      'shift-1',
      expect.anything(),
      expect.objectContaining({ expectedClosingCash: 1300 }),
      expect.anything(),
    );
  });

  it('leaves expectedClosingCash unchanged when there are no cash refunds during the shift (Part K #10 baseline)', async () => {
    baseMocks();
    vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(0));

    const result = await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }] }, SUPERVISOR, null);

    expect(result.expected_closing_cash).toBe(1500);
  });

  it('never reads or writes any shift other than the one being closed — the earlier original sale shift is never touched (Part F)', async () => {
    baseMocks();
    vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(200));

    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 300, quantity: 1 }] }, SUPERVISOR, null);

    // Called twice for this same shift — the pre-lock status check, and the
    // post-lock re-check (Task 209.52A) — never for any other shift.
    expect(cashRepository.findShiftById).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(cashRepository.findShiftById).mock.calls) {
      expect(call[0]).toBe('shift-1');
    }
    expect(cashRepository.closeShift).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cashRepository.closeShift).mock.calls[0]?.[0]).toBe('shift-1');
  });

  it('passes this shift\'s id/branchId/startedAt and a closing-time window end into the refund-attribution query', async () => {
    const startedAt = new Date('2026-08-01T08:00:00.000Z');
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId: 'branch-7', startedAt, openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    const before = new Date();
    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);
    const after = new Date();

    expect(cashRepository.sumCashRefundsProcessedDuringShift).toHaveBeenCalledTimes(1);
    const [shiftArg, windowEndArg] = vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mock.calls[0] ?? [];
    expect(shiftArg).toEqual({ id: 'shift-1', branchId: 'branch-7', startedAt });
    expect((windowEndArg as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect((windowEndArg as Date).getTime()).toBeLessThanOrEqual(after.getTime());
  });

  // Part G / Part K #11 — the worked example from the task spec: opening
  // ₱1,000, a ₱500 cash sale, then a same-shift refund of that same sale.
  // sumTransactionsForShift already excludes the refunded transaction from
  // cashSalesTotal (its status is no longer 'completed'), and
  // sumCashRefundsProcessedDuringShift's shiftId-exclusion clause (proven in
  // cash.repository.test.ts) excludes it too — so neither term carries it,
  // and the drawer nets to exactly the opening float, not ₱500 short.
  it('does not double-subtract a same-shift cash sale + refund — expected drawer stays at the opening float', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      // The ₱500 sale was refunded within this same shift, so it's already
      // excluded here (status is no longer 'completed').
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 1,
      totalTransactionCount: 1,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    // Real query excludes shiftId === this shift's own id, so a same-shift
    // refund never appears in this sum either.
    vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(0));
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    const result = await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);

    expect(result.expected_closing_cash).toBe(1000);
    expect(result.cash_variance).toBe(0);
  });

  // Part H — the same branch-scoped advisory lock transactionsService.
  // refundTransaction takes for a CASH refund must be taken here too, before
  // the sales/refund totals are read, so the two can't interleave.
  it('takes the branch-scoped advisory lock before reading sales/refund totals or writing the close', async () => {
    baseMocks();
    vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(0));

    // opening 1000 + cash sales 500 - refunds 0 = expected 1500, matched exactly by the count below.
    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }] }, SUPERVISOR, null);

    // Capture the tx object cashRepository actually saw (its identity, not
    // its import path — see the vi.mock('../../lib/prisma.js', ...) comment
    // above for why it isn't imported directly).
    const tx = vi.mocked(cashRepository.sumTransactionsForShift).mock.calls[0]?.[1] as unknown as { $executeRaw: ReturnType<typeof vi.fn> };
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const lockCallOrder = vi.mocked(tx.$executeRaw).mock.invocationCallOrder[0] ?? -1;
    const sumCallOrder = vi.mocked(cashRepository.sumTransactionsForShift).mock.invocationCallOrder[0] ?? -1;
    const refundSumCallOrder = vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mock.invocationCallOrder[0] ?? -1;
    const writeCallOrder = vi.mocked(cashRepository.closeShift).mock.invocationCallOrder[0] ?? -1;
    expect(lockCallOrder).toBeGreaterThanOrEqual(0);
    expect(lockCallOrder).toBeLessThan(sumCallOrder);
    expect(lockCallOrder).toBeLessThan(refundSumCallOrder);
    expect(lockCallOrder).toBeLessThan(writeCallOrder);
  });
});

describe('cashService.approveVariance', () => {
  it('rejects with 409 SHIFT_NOT_PENDING_REVIEW when the shift is not flagged', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);

    await expect(
      cashService.approveVariance('shift-1', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SHIFT_NOT_PENDING_REVIEW', statusCode: 409 });
  });

  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(
      cashService.approveVariance('missing', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('approves a flagged shift and closes it', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'flagged' }) as never);
    vi.mocked(cashRepository.approveVariance).mockResolvedValue(shiftRow({ status: 'closed', varianceApproved: true }) as never);

    const result = await cashService.approveVariance('shift-1', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(result.status).toBe('closed');
    expect(cashRepository.approveVariance).toHaveBeenCalledWith('shift-1', { approved: true, notes: 'x'.repeat(50), approvedBy: 'admin-1' });
  });

  it('broadcasts CASH_VARIANCE_APPROVED to the branch room and Super Admin when approved', async () => {
    const branchId = randomUUID();
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId, status: 'flagged', cashVariance: decimal(-50) }) as never);
    vi.mocked(cashRepository.approveVariance).mockResolvedValue(
      shiftRow({ branchId, status: 'closed', varianceApproved: true, cashVariance: decimal(-50) }) as never,
    );

    await cashService.approveVariance('shift-1', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(notifyBranch).toHaveBeenCalledWith(
      branchId,
      'cash:variance_approved',
      expect.objectContaining({ shiftId: 'shift-1', branchId, approvedBy: SUPER_ADMIN.id, variance: -50 }),
    );
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:variance_approved', expect.objectContaining({ shiftId: 'shift-1' }));
  });

  it('does not broadcast CASH_VARIANCE_APPROVED when the variance is rejected', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'flagged' }) as never);
    vi.mocked(cashRepository.approveVariance).mockResolvedValue(shiftRow({ status: 'flagged', varianceApproved: false }) as never);

    await cashService.approveVariance('shift-1', { approved: false, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(notifyBranch).not.toHaveBeenCalledWith(expect.anything(), 'cash:variance_approved', expect.anything());
    expect(notifySuperAdmin).not.toHaveBeenCalledWith('cash:variance_approved', expect.anything());
  });
});

describe('cashService.voidShift', () => {
  it('rejects with 409 SHIFT_HAS_TRANSACTIONS when the shift has recorded transactions', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);
    vi.mocked(cashRepository.countAnyTransactionsForShift).mockResolvedValue(1);

    await expect(cashService.voidShift('shift-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'SHIFT_HAS_TRANSACTIONS',
      statusCode: 409,
    });
    expect(cashRepository.voidShift).not.toHaveBeenCalled();
  });

  it('rejects with 409 SHIFT_NOT_OPEN when the shift is not active', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'closed' }) as never);

    await expect(cashService.voidShift('shift-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'SHIFT_NOT_OPEN',
      statusCode: 409,
    });
  });

  it('voids an open shift with zero transactions', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);
    vi.mocked(cashRepository.countAnyTransactionsForShift).mockResolvedValue(0);
    vi.mocked(cashRepository.voidShift).mockResolvedValue(shiftRow({ status: 'closed', shiftNotes: 'VOIDED — shift had zero transactions' }) as never);

    const result = await cashService.voidShift('shift-1', undefined, SUPER_ADMIN, null);

    expect(result.status).toBe('closed');
    expect(cashRepository.voidShift).toHaveBeenCalledWith('shift-1', { voidedBy: 'admin-1', note: expect.stringContaining('VOIDED') });
  });
});

describe('cashService.getShiftSummary', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(cashService.getShiftSummary('missing')).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('computes summary live for an OPEN shift, with actual_cash/variance/variance_status null', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active', openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(200),
      gcashSalesTotal: new Prisma.Decimal(50),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 3,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 2,
      gcashSalesCount: 1,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 3,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });

    const result = await cashService.getShiftSummary('shift-1');

    expect(result.shift.status).toBe('active');
    expect(result.summary).toMatchObject({
      cash_sales_total: 200,
      gcash_sales_total: 50,
      total_sales: 250,
      expected_cash: 1200,
      actual_cash: null,
      variance: null,
      variance_status: null,
    });
  });

  it('returns the stored (not recomputed) values for a CLOSED shift', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(
      shiftRow({
        status: 'closed',
        cashSalesTotal: decimal(500),
        gcashSalesTotal: decimal(100),
        cashSalesCount: 4,
        gcashSalesCount: 1,
        mayaSalesCount: 0,
        otherSalesCount: 0,
        voidedCount: 0,
        refundedCount: 1,
        totalTransactionCount: 6,
        totalDiscountAmount: decimal(75),
        pwdScTransactionCount: 3,
        closingCashAmount: decimal(1500),
        expectedClosingCash: decimal(1500),
        cashVariance: decimal(0),
      }) as never,
    );

    const result = await cashService.getShiftSummary('shift-1');

    expect(cashRepository.sumTransactionsForShift).not.toHaveBeenCalled();
    expect(cashRepository.sumTransactionCountsForShift).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({
      cash_sales_total: 500,
      gcash_sales_total: 100,
      total_sales: 600,
      pwd_sc_transaction_count: 3,
      actual_cash: 1500,
      variance: 0,
      variance_status: 'AUTO_APPROVED',
    });
  });

  it('counts only COMPLETED PWD/Senior-Citizen transactions in pwd_sc_transaction_count (live path)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 5,
    });

    const result = await cashService.getShiftSummary('shift-1');

    expect(result.summary.pwd_sc_transaction_count).toBe(5);
    expect(cashRepository.sumTransactionCountsForShift).toHaveBeenCalledWith('shift-1');
  });

  it('flags a FLAGGED shift as PENDING_REVIEW in variance_status', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'flagged', cashVariance: decimal(-50) }) as never);

    const result = await cashService.getShiftSummary('shift-1');

    expect(result.summary.variance_status).toBe('PENDING_REVIEW');
  });

  // Task 209.41 Part E/I — the live (still-open) expected_cash figure must
  // also subtract cash refunds processed during this shift, the same way
  // closeShift's persisted formula does.
  it('subtracts a live cash-refund total from expected_cash for an OPEN shift', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active', openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(500),
      gcashSalesTotal: new Prisma.Decimal(0),
      mayaSalesTotal: new Prisma.Decimal(0),
      otherSalesTotal: new Prisma.Decimal(0),
      grossSalesTotal: new Prisma.Decimal(0),
      transactionCount: 1,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 1,
      gcashSalesCount: 0,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 1,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.sumCashRefundsProcessedDuringShift).mockResolvedValue(new Prisma.Decimal(200));

    const result = await cashService.getShiftSummary('shift-1');

    // 1000 opening + 500 cash sales - 200 prior-shift cash refund = 1300.
    expect(result.summary.expected_cash).toBe(1300);
  });

  it('does not recompute a live cash-refund total for a CLOSED shift — its persisted expected_closing_cash is already final (Part F)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(
      shiftRow({ status: 'closed', expectedClosingCash: decimal(1300), closingCashAmount: decimal(1300), cashVariance: decimal(0) }) as never,
    );

    const result = await cashService.getShiftSummary('shift-1');

    expect(cashRepository.sumCashRefundsProcessedDuringShift).not.toHaveBeenCalled();
    expect(result.summary.expected_cash).toBe(1300);
  });
});

function reviewRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'review-1',
    shiftId: 'shift-1',
    phase: 'opening',
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    notes: null,
    createdAt: new Date('2026-01-01T08:00:00.000Z'),
    updatedAt: new Date('2026-01-01T08:00:00.000Z'),
    ...overrides,
  };
}

describe('cashService.getShiftReviews', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(cashService.getShiftReviews('missing')).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('returns both opening and closing review rows for a shift', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow() as never);
    vi.mocked(cashRepository.listReviewsForShift).mockResolvedValue([
      reviewRow({ phase: 'opening' }),
      reviewRow({ id: 'review-2', phase: 'closing' }),
    ] as never);

    const result = await cashService.getShiftReviews('shift-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ phase: 'opening', status: 'pending' });
    expect(result[1]).toMatchObject({ phase: 'closing', status: 'pending' });
  });
});

describe('cashService.reviewShift', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(
      cashService.reviewShift('missing', 'opening', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('rejects with 409 SHIFT_NOT_CLOSED_YET when reviewing the closing phase while the shift is still active', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);

    await expect(
      cashService.reviewShift('shift-1', 'closing', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SHIFT_NOT_CLOSED_YET', statusCode: 409 });
    expect(cashRepository.submitReview).not.toHaveBeenCalled();
  });

  it('allows reviewing the opening phase while the shift is still active', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);
    vi.mocked(cashRepository.findReview).mockResolvedValue(reviewRow({ phase: 'opening' }) as never);
    vi.mocked(cashRepository.submitReview).mockResolvedValue(
      reviewRow({ phase: 'opening', status: 'approved', reviewedBy: SUPER_ADMIN.id, reviewedAt: new Date() }) as never,
    );

    const result = await cashService.reviewShift('shift-1', 'opening', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(result.status).toBe('approved');
  });

  it('rejects with 404 SHIFT_REVIEW_NOT_FOUND when no review row exists for this shift/phase', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'closed' }) as never);
    vi.mocked(cashRepository.findReview).mockResolvedValue(null);

    await expect(
      cashService.reviewShift('shift-1', 'closing', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SHIFT_REVIEW_NOT_FOUND', statusCode: 404 });
  });

  it('rejects with 409 SHIFT_REVIEW_ALREADY_DECIDED when the review is no longer pending', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'closed' }) as never);
    vi.mocked(cashRepository.findReview).mockResolvedValue(reviewRow({ status: 'approved' }) as never);

    await expect(
      cashService.reviewShift('shift-1', 'closing', { approved: false, notes: 'x'.repeat(50) }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SHIFT_REVIEW_ALREADY_DECIDED', statusCode: 409 });
    expect(cashRepository.submitReview).not.toHaveBeenCalled();
  });

  it('approves a pending closing review once the shift is closed, and broadcasts SHIFT_REVIEW_UPDATED', async () => {
    const branchId = randomUUID();
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId, status: 'closed' }) as never);
    vi.mocked(cashRepository.findReview).mockResolvedValue(reviewRow({ phase: 'closing' }) as never);
    vi.mocked(cashRepository.submitReview).mockResolvedValue(
      reviewRow({ phase: 'closing', status: 'approved', reviewedBy: SUPER_ADMIN.id, reviewedAt: new Date() }) as never,
    );

    const result = await cashService.reviewShift('shift-1', 'closing', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(result.status).toBe('approved');
    expect(cashRepository.submitReview).toHaveBeenCalledWith('shift-1', 'closing', {
      approved: true,
      notes: 'x'.repeat(50),
      reviewedBy: SUPER_ADMIN.id,
    });
    expect(notifyBranch).toHaveBeenCalledWith(
      branchId,
      'cash:shift_review_updated',
      expect.objectContaining({ shiftId: 'shift-1', phase: 'closing', status: 'approved', reviewedBy: SUPER_ADMIN.id }),
    );
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:shift_review_updated', expect.objectContaining({ shiftId: 'shift-1' }));
  });

  it('records a rejected decision with the actor as reviewer', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'closed' }) as never);
    vi.mocked(cashRepository.findReview).mockResolvedValue(reviewRow({ phase: 'closing' }) as never);
    vi.mocked(cashRepository.submitReview).mockResolvedValue(
      reviewRow({ phase: 'closing', status: 'rejected', reviewedBy: SUPERVISOR.id, reviewedAt: new Date() }) as never,
    );

    const result = await cashService.reviewShift('shift-1', 'closing', { approved: false, notes: 'x'.repeat(50) }, SUPERVISOR, null);

    expect(result.status).toBe('rejected');
    expect(result.reviewed_by).toBe(SUPERVISOR.id);
  });
});

describe('cashService.listPendingReviews', () => {
  it('maps repository rows into the API shape, including the nested shift summary', async () => {
    const branchId = randomUUID();
    vi.mocked(cashRepository.listPendingReviews).mockResolvedValue({
      reviews: [
        {
          ...reviewRow({ phase: 'opening' }),
          shift: {
            id: 'shift-1',
            branchId,
            cashierId: 'cashier-1',
            status: 'active',
            startedAt: new Date('2026-01-01T08:00:00.000Z'),
            closedAt: null,
          },
        },
      ],
      total: 1,
    } as never);

    const result = await cashService.listPendingReviews({ page: 1, limit: 25 });

    expect(result.total).toBe(1);
    expect(result.reviews[0]).toMatchObject({
      phase: 'opening',
      status: 'pending',
      shift: { id: 'shift-1', branch_id: branchId, status: 'active' },
    });
  });
});
