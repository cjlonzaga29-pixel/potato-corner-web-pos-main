import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Mocks lib/prisma.js directly (same technique as inventory.repository.test.ts)
 * so each repository method's exact where/data shape can be asserted —
 * cash.repository.ts is the only place in this module allowed to touch Prisma.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    shift: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    shiftCashDenomination: {
      createMany: vi.fn(),
    },
    shiftReview: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    transaction: {
      groupBy: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { cashRepository } = await import('./cash.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cashRepository.findActiveShift', () => {
  it('scopes to one cashier at one branch with status active — used by shiftGuard, must not change shape', async () => {
    vi.mocked(prisma.shift.findFirst).mockResolvedValue({ id: 'shift-1' } as never);

    await cashRepository.findActiveShift('user-1', 'branch-1');

    expect(prisma.shift.findFirst).toHaveBeenCalledWith({
      where: { cashierId: 'user-1', branchId: 'branch-1', status: 'active' },
    });
  });
});

describe('cashRepository.findActiveShiftByBranch', () => {
  it('scopes to branch + active status only, regardless of cashier, and includes denominations', async () => {
    vi.mocked(prisma.shift.findFirst).mockResolvedValue(null);

    await cashRepository.findActiveShiftByBranch('branch-1');

    expect(prisma.shift.findFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: 'active' },
      include: { denominations: true },
    });
  });

  // Task 209.41 — refundTransaction's CASH-refund active-shift lookup must
  // run inside the same locked transaction as the refund write.
  it('reads through the given transaction client instead of root prisma when one is passed', async () => {
    const txFindFirst = vi.fn().mockResolvedValue(null);
    const tx = { shift: { findFirst: txFindFirst } };

    await cashRepository.findActiveShiftByBranch('branch-1', tx as never);

    expect(txFindFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: 'active' },
      include: { denominations: true },
    });
    expect(prisma.shift.findFirst).not.toHaveBeenCalled();
  });
});

describe('cashRepository.findShiftById', () => {
  it('includes denominations', async () => {
    vi.mocked(prisma.shift.findUnique).mockResolvedValue(null);

    await cashRepository.findShiftById('shift-1');

    expect(prisma.shift.findUnique).toHaveBeenCalledWith({ where: { id: 'shift-1' }, include: { denominations: true } });
  });

  // Task 209.52A — closeShift's post-lock re-check must read through the
  // same tx client the lock was taken on, not root prisma.
  it('reads through the given transaction client instead of root prisma when one is passed', async () => {
    const txFindUnique = vi.fn().mockResolvedValue(null);
    const tx = { shift: { findUnique: txFindUnique } };

    await cashRepository.findShiftById('shift-1', tx as never);

    expect(txFindUnique).toHaveBeenCalledWith({ where: { id: 'shift-1' }, include: { denominations: true } });
    expect(prisma.shift.findUnique).not.toHaveBeenCalled();
  });
});

describe('cashRepository.createShift', () => {
  it('creates the shift row, writes opening denominations, and re-fetches with denominations included', async () => {
    vi.mocked(prisma.shift.create).mockResolvedValue({ id: 'shift-1' } as never);
    vi.mocked(prisma.shift.findUniqueOrThrow).mockResolvedValue({ id: 'shift-1', denominations: [] } as never);

    await cashRepository.createShift({
      branchId: 'branch-1',
      cashierId: 'user-1',
      openedBy: 'user-2',
      startingCash: 1100,
      denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 100, quantity: 1 }],
    });

    expect(prisma.shift.create).toHaveBeenCalledWith({
      data: {
        branchId: 'branch-1',
        cashierId: 'user-1',
        openedBy: 'user-2',
        openingCashAmount: 1100,
        startedAt: expect.any(Date),
      },
    });
    expect(prisma.shiftCashDenomination.createMany).toHaveBeenCalledWith({
      data: [
        { shiftId: 'shift-1', denomination: 1000, count: 1, totalValue: 1000, countType: 'opening' },
        { shiftId: 'shift-1', denomination: 100, count: 1, totalValue: 100, countType: 'opening' },
      ],
    });
    expect(prisma.shiftReview.createMany).toHaveBeenCalledWith({
      data: [
        { shiftId: 'shift-1', phase: 'opening' },
        { shiftId: 'shift-1', phase: 'closing' },
      ],
    });
    expect(prisma.shift.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'shift-1' }, include: { denominations: true } });
  });
});

describe('cashRepository.listReviewsForShift', () => {
  it('fetches both phase rows for a shift ordered by phase', async () => {
    vi.mocked(prisma.shiftReview.findMany).mockResolvedValue([]);

    await cashRepository.listReviewsForShift('shift-1');

    expect(prisma.shiftReview.findMany).toHaveBeenCalledWith({ where: { shiftId: 'shift-1' }, orderBy: { phase: 'asc' } });
  });
});

describe('cashRepository.findReview', () => {
  it('looks up a single phase row via the shiftId_phase compound unique key', async () => {
    vi.mocked(prisma.shiftReview.findUnique).mockResolvedValue(null);

    await cashRepository.findReview('shift-1', 'opening');

    expect(prisma.shiftReview.findUnique).toHaveBeenCalledWith({ where: { shiftId_phase: { shiftId: 'shift-1', phase: 'opening' } } });
  });
});

describe('cashRepository.submitReview', () => {
  it('records an approval with reviewer and timestamp', async () => {
    vi.mocked(prisma.shiftReview.update).mockResolvedValue({ id: 'review-1' } as never);

    await cashRepository.submitReview('shift-1', 'closing', { approved: true, notes: 'x'.repeat(50), reviewedBy: 'admin-1' });

    expect(prisma.shiftReview.update).toHaveBeenCalledWith({
      where: { shiftId_phase: { shiftId: 'shift-1', phase: 'closing' } },
      data: { status: 'approved', reviewedBy: 'admin-1', reviewedAt: expect.any(Date), notes: 'x'.repeat(50) },
    });
  });

  it('records a rejection', async () => {
    vi.mocked(prisma.shiftReview.update).mockResolvedValue({ id: 'review-1' } as never);

    await cashRepository.submitReview('shift-1', 'opening', { approved: false, notes: 'x'.repeat(50), reviewedBy: 'admin-1' });

    expect(prisma.shiftReview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) }),
    );
  });
});

describe('cashRepository.listPendingReviews', () => {
  it('filters to pending status, scopes to the given branch ids, applies the phase filter, and paginates', async () => {
    vi.mocked(prisma.shiftReview.findMany).mockResolvedValue([]);
    vi.mocked(prisma.shiftReview.count).mockResolvedValue(0);

    await cashRepository.listPendingReviews({ branchIds: ['branch-1'], phase: 'opening', page: 2, limit: 10 });

    expect(prisma.shiftReview.findMany).toHaveBeenCalledWith({
      where: { status: 'pending', phase: 'opening', shift: { branchId: { in: ['branch-1'] } } },
      include: { shift: { select: { id: true, branchId: true, cashierId: true, status: true, startedAt: true, closedAt: true } } },
      orderBy: { createdAt: 'asc' },
      skip: 10,
      take: 10,
    });
    expect(prisma.shiftReview.count).toHaveBeenCalledWith({ where: { status: 'pending', phase: 'opening', shift: { branchId: { in: ['branch-1'] } } } });
  });

  it("omits the branch filter from the where clause when branchIds is 'all' (super_admin, unfiltered)", async () => {
    vi.mocked(prisma.shiftReview.findMany).mockResolvedValue([]);
    vi.mocked(prisma.shiftReview.count).mockResolvedValue(0);

    await cashRepository.listPendingReviews({ branchIds: 'all', page: 1, limit: 25 });

    expect(prisma.shiftReview.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending' } }));
  });
});

describe('cashRepository.sumTransactionsForShift', () => {
  it('splits completed-transaction totals by payment method and defaults missing rows to zero', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { paymentMethod: 'cash', _sum: { totalAmount: new Prisma.Decimal(500) }, _count: { _all: 3 } },
    ] as never);

    const result = await cashRepository.sumTransactionsForShift('shift-1');

    expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
      by: ['paymentMethod'],
      where: { shiftId: 'shift-1', status: 'completed' },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    expect(result.cashSalesTotal.toNumber()).toBe(500);
    expect(result.gcashSalesTotal.toNumber()).toBe(0);
    expect(result.transactionCount).toBe(3);
  });

  it('reads through the given transaction client instead of root prisma when one is passed', async () => {
    const txGroupBy = vi.fn().mockResolvedValue([]);
    const tx = { transaction: { groupBy: txGroupBy } };

    await cashRepository.sumTransactionsForShift('shift-1', tx as never);

    expect(txGroupBy).toHaveBeenCalledWith({
      by: ['paymentMethod'],
      where: { shiftId: 'shift-1', status: 'completed' },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    expect(prisma.transaction.groupBy).not.toHaveBeenCalled();
  });
});

describe('cashRepository.sumTransactionCountsForShift', () => {
  it('splits completed counts by payment method, sums voided/refunded/total/pwd-sc/discount', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { paymentMethod: 'cash', status: 'completed', _count: { _all: 5 } },
      { paymentMethod: 'gcash', status: 'completed', _count: { _all: 3 } },
      { paymentMethod: 'cash', status: 'voided', _count: { _all: 1 } },
      { paymentMethod: 'gcash', status: 'refunded', _count: { _all: 2 } },
    ] as never);
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { discountAmount: new Prisma.Decimal(150) } } as never);
    vi.mocked(prisma.transaction.count).mockResolvedValueOnce(4).mockResolvedValueOnce(11);

    const result = await cashRepository.sumTransactionCountsForShift('shift-1');

    expect(result).toEqual({
      cashSalesCount: 5,
      gcashSalesCount: 3,
      mayaSalesCount: 0,
      otherSalesCount: 0,
      voidedCount: 1,
      refundedCount: 2,
      totalTransactionCount: 11,
      totalDiscountAmount: 150,
      pwdScTransactionCount: 4,
    });
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
      by: ['paymentMethod', 'status'],
      where: { shiftId: 'shift-1' },
      _count: { _all: true },
    });
    expect(prisma.transaction.aggregate).toHaveBeenCalledWith({
      where: { shiftId: 'shift-1', status: 'completed' },
      _sum: { discountAmount: true },
    });
    expect(prisma.transaction.count).toHaveBeenNthCalledWith(1, {
      where: { shiftId: 'shift-1', status: 'completed', discountType: { in: ['pwd', 'senior_citizen'] } },
    });
    expect(prisma.transaction.count).toHaveBeenNthCalledWith(2, { where: { shiftId: 'shift-1' } });
  });

  it('returns all zeros when the shift has no transactions', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { discountAmount: null } } as never);
    vi.mocked(prisma.transaction.count).mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const result = await cashRepository.sumTransactionCountsForShift('shift-1');

    expect(result).toEqual({
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
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
      by: ['paymentMethod', 'status'],
      where: { shiftId: 'shift-1' },
      _count: { _all: true },
    });
    expect(prisma.transaction.aggregate).toHaveBeenCalledWith({
      where: { shiftId: 'shift-1', status: 'completed' },
      _sum: { discountAmount: true },
    });
  });

  it('reads through the given transaction client instead of root prisma when one is passed', async () => {
    const tx = {
      transaction: {
        groupBy: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { discountAmount: null } }),
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0),
      },
    };

    await cashRepository.sumTransactionCountsForShift('shift-1', tx as never);

    expect(tx.transaction.groupBy).toHaveBeenCalled();
    expect(tx.transaction.aggregate).toHaveBeenCalled();
    expect(tx.transaction.count).toHaveBeenCalledTimes(2);
    expect(prisma.transaction.groupBy).not.toHaveBeenCalled();
    expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
    expect(prisma.transaction.count).not.toHaveBeenCalled();
  });
});

describe('cashRepository.sumCashRefundsProcessedDuringShift', () => {
  const shift = { id: 'shift-101', branchId: 'branch-1', startedAt: new Date('2026-08-01T08:00:00.000Z') };
  const windowEnd = new Date('2026-08-01T20:00:00.000Z');

  it('sums CASH refunds for the branch inside the time window, excluding this shift\'s own original sales (Part D/G)', async () => {
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { totalAmount: new Prisma.Decimal(500) } } as never);

    const result = await cashRepository.sumCashRefundsProcessedDuringShift(shift, windowEnd);

    expect(prisma.transaction.aggregate).toHaveBeenCalledWith({
      where: {
        branchId: 'branch-1',
        paymentMethod: 'cash',
        status: 'refunded',
        refundedAt: { gte: shift.startedAt, lte: windowEnd },
        shiftId: { not: 'shift-101' },
      },
      _sum: { totalAmount: true },
    });
    expect(result.toNumber()).toBe(500);
  });

  it('defaults to zero when there are no matching refunds', async () => {
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { totalAmount: null } } as never);

    const result = await cashRepository.sumCashRefundsProcessedDuringShift(shift, windowEnd);

    expect(result.toNumber()).toBe(0);
  });

  it('reads through the given transaction client instead of root prisma when one is passed', async () => {
    const txAggregate = vi.fn().mockResolvedValue({ _sum: { totalAmount: new Prisma.Decimal(200) } });
    const tx = { transaction: { aggregate: txAggregate } };

    const result = await cashRepository.sumCashRefundsProcessedDuringShift(shift, windowEnd, tx as never);

    expect(txAggregate).toHaveBeenCalled();
    expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
    expect(result.toNumber()).toBe(200);
  });
});

describe('cashRepository.countAnyTransactionsForShift', () => {
  it('counts every transaction regardless of status', async () => {
    vi.mocked(prisma.transaction.count).mockResolvedValue(2);

    const result = await cashRepository.countAnyTransactionsForShift('shift-1');

    expect(prisma.transaction.count).toHaveBeenCalledWith({ where: { shiftId: 'shift-1' } });
    expect(result).toBe(2);
  });
});

describe('cashRepository.closeShift', () => {
  it('writes closing denominations and updates the shift with every computed field, using the passed-in transaction client rather than root prisma', async () => {
    vi.mocked(prisma.shift.update).mockResolvedValue({ id: 'shift-1' } as never);

    await cashRepository.closeShift(
      'shift-1',
      { denominations: [{ denomination: 500, quantity: 2 }], notes: 'end of day', varianceExplanation: undefined },
      {
        closingCashAmount: 1000,
        expectedClosingCash: 1000,
        cashVariance: 0,
        cashSalesTotal: 500,
        gcashSalesTotal: 0,
        mayaSalesTotal: 0,
        otherSalesTotal: 0,
        grossSalesTotal: 0,
        transactionCount: 5,
        cashSalesCount: 2,
        gcashSalesCount: 1,
        mayaSalesCount: 0,
        otherSalesCount: 0,
        voidedCount: 0,
        refundedCount: 0,
        totalTransactionCount: 3,
        totalDiscountAmount: 25,
        pwdScTransactionCount: 1,
        status: 'closed',
        varianceApproved: true,
        closedBy: 'user-1',
      },
      prisma as never,
    );

    // closeShift no longer opens its own $transaction — the caller (cashService)
    // owns the transaction boundary and passes tx in, so this repository call
    // never touches prisma.$transaction directly.
    expect(prisma.$transaction).not.toHaveBeenCalled();

    expect(prisma.shiftCashDenomination.createMany).toHaveBeenCalledWith({
      data: [{ shiftId: 'shift-1', denomination: 500, count: 2, totalValue: 1000, countType: 'closing' }],
    });
    expect(prisma.shift.update).toHaveBeenCalledWith({
      where: { id: 'shift-1' },
      data: {
        closingCashAmount: 1000,
        expectedClosingCash: 1000,
        cashVariance: 0,
        cashSalesTotal: 500,
        gcashSalesTotal: 0,
        mayaSalesTotal: 0,
        otherSalesTotal: 0,
        grossSalesTotal: 0,
        transactionCount: 5,
        cashSalesCount: 2,
        gcashSalesCount: 1,
        mayaSalesCount: 0,
        otherSalesCount: 0,
        voidedCount: 0,
        refundedCount: 0,
        totalTransactionCount: 3,
        totalDiscountAmount: 25,
        pwdScTransactionCount: 1,
        status: 'closed',
        varianceApproved: true,
        varianceExplanation: undefined,
        shiftNotes: 'end of day',
        closedBy: 'user-1',
        closedAt: expect.any(Date),
      },
      include: { denominations: true },
    });
  });
});

describe('cashRepository.approveVariance', () => {
  it('sets variance approval fields and forces status to closed', async () => {
    vi.mocked(prisma.shift.update).mockResolvedValue({ id: 'shift-1' } as never);

    await cashRepository.approveVariance('shift-1', { approved: false, notes: 'x'.repeat(50), approvedBy: 'admin-1' });

    expect(prisma.shift.update).toHaveBeenCalledWith({
      where: { id: 'shift-1' },
      data: {
        varianceApproved: false,
        varianceApprovedBy: 'admin-1',
        varianceApprovalReason: 'x'.repeat(50),
        status: 'closed',
      },
      include: { denominations: true },
    });
  });
});

describe('cashRepository.voidShift', () => {
  it('closes the shift and stamps the void note/actor', async () => {
    vi.mocked(prisma.shift.update).mockResolvedValue({ id: 'shift-1' } as never);

    await cashRepository.voidShift('shift-1', { voidedBy: 'admin-1', note: 'VOIDED — shift had zero transactions' });

    expect(prisma.shift.update).toHaveBeenCalledWith({
      where: { id: 'shift-1' },
      data: {
        status: 'closed',
        closedBy: 'admin-1',
        closedAt: expect.any(Date),
        shiftNotes: 'VOIDED — shift had zero transactions',
      },
      include: { denominations: true },
    });
  });
});

describe('cashRepository.findCashiersWithClosedShifts', () => {
  it('returns distinct cashierIds for shifts closed in the window', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([{ cashierId: 'user-1' }, { cashierId: 'user-2' }] as never);

    const dayStart = new Date('2026-07-16T16:00:00.000Z');
    const dayEnd = new Date('2026-07-17T15:59:59.999Z');
    const result = await cashRepository.findCashiersWithClosedShifts('branch-1', dayStart, dayEnd);

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: { cashierId: true },
      distinct: ['cashierId'],
    });
    expect(result).toEqual(['user-1', 'user-2']);
  });
});

describe('cashRepository.findLastNClosedShiftsForCashier', () => {
  it('fetches the N most recently closed shifts for one cashier at one branch', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);

    await cashRepository.findLastNClosedShiftsForCashier('user-1', 'branch-1', 10);

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { cashierId: 'user-1', branchId: 'branch-1', status: { in: ['closed', 'flagged'] } },
      orderBy: { closedAt: 'desc' },
      take: 10,
      select: { id: true, varianceApproved: true, closedAt: true },
    });
  });
});

describe('cashRepository.countUnresolvedVariancesInWindow', () => {
  it('counts flagged shifts closed within the given window', async () => {
    vi.mocked(prisma.shift.count).mockResolvedValue(2);

    const dayStart = new Date('2026-07-17T00:00:00.000Z');
    const dayEnd = new Date('2026-07-17T23:59:59.999Z');
    const result = await cashRepository.countUnresolvedVariancesInWindow(dayStart, dayEnd);

    expect(prisma.shift.count).toHaveBeenCalledWith({
      where: { status: 'flagged', closedAt: { gte: dayStart, lte: dayEnd } },
    });
    expect(result).toBe(2);
  });
});

describe('cashRepository.listShifts', () => {
  it('applies branch/status filters and pagination', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);
    vi.mocked(prisma.shift.count).mockResolvedValue(0);

    await cashRepository.listShifts({ branchId: 'branch-1', status: 'closed', page: 2, limit: 10 });

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: 'closed' },
      include: { denominations: true },
      orderBy: { startedAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(prisma.shift.count).toHaveBeenCalledWith({ where: { branchId: 'branch-1', status: 'closed' } });
  });

  it('omits branch/status from the where clause when not provided', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);
    vi.mocked(prisma.shift.count).mockResolvedValue(0);

    await cashRepository.listShifts({ page: 1, limit: 25 });

    expect(prisma.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});
