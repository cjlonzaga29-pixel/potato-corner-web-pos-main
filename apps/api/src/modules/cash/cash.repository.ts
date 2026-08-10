import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { AutoOpenShiftData, CloseShiftData, DenominationCountInput, OpenShiftData, ShiftListFilters, ShiftCloseComputedCounts } from './cash.types.js';

const shiftInclude = {
  denominations: true,
} satisfies Prisma.ShiftInclude;

/**
 * Cash repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const cashRepository = {
  /** Read-only lookup used by the shift-guard middleware (Phase 2 RBAC) — one cashier's own active shift. */
  findActiveShift(cashierId: string, branchId: string) {
    return prisma.shift.findFirst({
      where: { cashierId, branchId, status: 'active' },
    });
  },

  /**
   * Whether *any* shift is currently open at a branch — used by GET /current,
   * the open-shift 409 guard, and (Task 209.41, with `tx`) the CASH-refund
   * active-processing-shift lookup, which must run inside the same locked
   * transaction as the refund write — see branchShiftLockId in pg-lock.ts.
   */
  findActiveShiftByBranch(branchId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.shift.findFirst({
      where: { branchId, status: 'active' },
      include: shiftInclude,
    });
  },

  findShiftById(id: string) {
    return prisma.shift.findUnique({ where: { id }, include: shiftInclude });
  },

  findUserById(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } });
  },

  async createShift(data: OpenShiftData) {
    return prisma.$transaction(async (tx) => {
      const shift = await tx.shift.create({
        data: {
          branchId: data.branchId,
          cashierId: data.cashierId,
          openedBy: data.openedBy,
          openingCashAmount: data.startingCash,
          startedAt: new Date(),
        },
      });

      await tx.shiftCashDenomination.createMany({
        data: data.denominations.map((d) => denominationRow(shift.id, d, 'opening')),
      });

      // Both review rows are created eagerly (Production Stabilization sprint,
      // 2026-07) so "pending review" queues can be a plain WHERE status = 'pending'
      // rather than an anti-join against shifts with no row yet.
      await tx.shiftReview.createMany({
        data: [
          { shiftId: shift.id, phase: 'opening' },
          { shiftId: shift.id, phase: 'closing' },
        ],
      });

      return tx.shift.findUniqueOrThrow({ where: { id: shift.id }, include: shiftInclude });
    });
  },

  /**
   * Auto-managed shift, created transparently on clock-in (Phase 4-9 shift
   * removal) — no drawer count, no denomination rows, no ShiftReview rows.
   * Branch-scoped, like createShift: the `shift_one_open_per_branch` partial
   * unique index (migration 20260714120000) allows exactly one ACTIVE shift
   * per branch, full stop — never several concurrent active auto-shifts for
   * different cashiers at the same branch. cashService.autoOpenShift checks
   * findActiveShiftByBranch (branch-wide, not per-cashier) before calling
   * this for exactly that reason (verified current as of Task 209.41).
   */
  createAutoShift(data: AutoOpenShiftData) {
    return prisma.shift.create({
      data: {
        branchId: data.branchId,
        cashierId: data.cashierId,
        openedBy: data.cashierId,
        openingCashAmount: 0,
        startedAt: new Date(),
      },
      include: shiftInclude,
    });
  },

  /**
   * Closes an auto-managed shift at clock-out — persists the same sales/count
   * aggregates the manual closeShift flow computes, but skips denominations,
   * variance, and status='flagged': there was never a drawer count to compare
   * against, so cashVariance/closingCashAmount/expectedClosingCash all stay
   * null and status goes straight to 'closed'.
   */
  closeAutoShift(
    id: string,
    computed: {
      cashSalesTotal: number;
      gcashSalesTotal: number;
      mayaSalesTotal: number;
      otherSalesTotal: number;
      grossSalesTotal: number;
      transactionCount: number;
      cashSalesCount: number;
      gcashSalesCount: number;
      mayaSalesCount: number;
      otherSalesCount: number;
      voidedCount: number;
      refundedCount: number;
      totalTransactionCount: number;
      totalDiscountAmount: number;
      pwdScTransactionCount: number;
      closedBy: string;
    },
  ) {
    return prisma.shift.update({
      where: { id },
      data: {
        cashSalesTotal: computed.cashSalesTotal,
        gcashSalesTotal: computed.gcashSalesTotal,
        mayaSalesTotal: computed.mayaSalesTotal,
        otherSalesTotal: computed.otherSalesTotal,
        grossSalesTotal: computed.grossSalesTotal,
        transactionCount: computed.transactionCount,
        cashSalesCount: computed.cashSalesCount,
        gcashSalesCount: computed.gcashSalesCount,
        mayaSalesCount: computed.mayaSalesCount,
        otherSalesCount: computed.otherSalesCount,
        voidedCount: computed.voidedCount,
        refundedCount: computed.refundedCount,
        totalTransactionCount: computed.totalTransactionCount,
        totalDiscountAmount: computed.totalDiscountAmount,
        pwdScTransactionCount: computed.pwdScTransactionCount,
        status: 'closed',
        closedBy: computed.closedBy,
        closedAt: new Date(),
      },
      include: shiftInclude,
    });
  },

  /**
   * Aggregates completed-transaction sales for a shift, split by payment
   * method — voided/refunded transactions never touched the physical
   * drawer, so they're excluded from cash_sales_total on purpose.
   */
  async sumTransactionsForShift(shiftId: string, tx?: Prisma.TransactionClient): Promise<{
    cashSalesTotal: Prisma.Decimal;
    gcashSalesTotal: Prisma.Decimal;
    mayaSalesTotal: Prisma.Decimal;
    otherSalesTotal: Prisma.Decimal;
    grossSalesTotal: Prisma.Decimal;
    transactionCount: number;
  }> {
    const client = tx ?? prisma;
    const rows = await client.transaction.groupBy({
      by: ['paymentMethod'],
      where: { shiftId, status: 'completed' },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });

    const cashSalesTotal = rows.find((r) => r.paymentMethod === 'cash')?._sum.totalAmount ?? new Prisma.Decimal(0);
    const gcashSalesTotal = rows.find((r) => r.paymentMethod === 'gcash')?._sum.totalAmount ?? new Prisma.Decimal(0);
    const mayaSalesTotal = rows.find((r) => r.paymentMethod === 'maya')?._sum.totalAmount ?? new Prisma.Decimal(0);
    const otherSalesTotal = rows.find((r) => r.paymentMethod === 'other')?._sum.totalAmount ?? new Prisma.Decimal(0);

    return {
      cashSalesTotal,
      gcashSalesTotal,
      mayaSalesTotal,
      otherSalesTotal,
      grossSalesTotal: cashSalesTotal.plus(gcashSalesTotal).plus(mayaSalesTotal).plus(otherSalesTotal),
      transactionCount: rows.reduce((sum, r) => sum + r._count._all, 0),
    };
  },

  /**
   * Close-time-only summary counts (BIR reporting fields) — computed fresh
   * every close, unlike cashSalesTotal/gcashSalesTotal which are also live-
   * overlaid for an open shift. cashSalesCount/gcashSalesCount are COMPLETED-
   * only per payment method; voidedCount/refundedCount span both payment
   * methods; totalTransactionCount is every status; totalDiscountAmount and
   * pwdScTransactionCount are COMPLETED-only (a voided PWD sale never
   * happened for reporting purposes).
   */
  async sumTransactionCountsForShift(shiftId: string, tx?: Prisma.TransactionClient): Promise<ShiftCloseComputedCounts> {
    const client = tx ?? prisma;
    const [statusRows, discountAgg, pwdScCount, totalCount] = await Promise.all([
      client.transaction.groupBy({
        by: ['paymentMethod', 'status'],
        where: { shiftId },
        _count: { _all: true },
      }),
      client.transaction.aggregate({
        where: { shiftId, status: 'completed' },
        _sum: { discountAmount: true },
      }),
      client.transaction.count({
        where: { shiftId, status: 'completed', discountType: { in: ['pwd', 'senior_citizen'] } },
      }),
      client.transaction.count({ where: { shiftId } }),
    ]);

    const cashSalesCount = statusRows.find((r) => r.paymentMethod === 'cash' && r.status === 'completed')?._count._all ?? 0;
    const gcashSalesCount = statusRows.find((r) => r.paymentMethod === 'gcash' && r.status === 'completed')?._count._all ?? 0;
    const mayaSalesCount = statusRows.find((r) => r.paymentMethod === 'maya' && r.status === 'completed')?._count._all ?? 0;
    const otherSalesCount = statusRows.find((r) => r.paymentMethod === 'other' && r.status === 'completed')?._count._all ?? 0;
    const voidedCount = statusRows.filter((r) => r.status === 'voided').reduce((sum, r) => sum + r._count._all, 0);
    const refundedCount = statusRows.filter((r) => r.status === 'refunded').reduce((sum, r) => sum + r._count._all, 0);

    return {
      cashSalesCount,
      gcashSalesCount,
      mayaSalesCount,
      otherSalesCount,
      voidedCount,
      refundedCount,
      totalTransactionCount: totalCount,
      totalDiscountAmount: discountAgg._sum.discountAmount?.toNumber() ?? 0,
      pwdScTransactionCount: pwdScCount,
    };
  },

  /**
   * CASH refunds this shift's drawer physically paid out as the PROCESSING
   * shift (Task 209.41 Part D) — never the shift the original sale belonged
   * to (Transaction.shiftId, which sumTransactionsForShift above keys off
   * of). Attribution is entirely by refundedAt falling inside this shift's
   * [startedAt, windowEnd] time window plus branch/payment-method/status —
   * the same fields sumTransactionsForShift already treats as authoritative
   * for "did this touch the physical drawer".
   *
   * Excludes rows where Transaction.shiftId === this shift's own id. This is
   * NOT refund-to-shift attribution (that's the time-window above) — it's a
   * double-count guard. A cash sale rung up and refunded within the same
   * still-active shift already drops out of sumTransactionsForShift's
   * cashSalesTotal the instant its status flips off 'completed', so its net
   * drawer effect (+X then -X) is already zero without this method's help.
   * Counting that same refund here too would subtract X a second time for a
   * transaction that never actually left the drawer short. A refund whose
   * original sale belongs to an earlier (already-closed) shift has no such
   * exclusion from cashSalesTotal to begin with (different shiftId, so it
   * was never in this shift's cashSalesTotal), so it's included here as a
   * real deduction against this shift's expected cash.
   */
  async sumCashRefundsProcessedDuringShift(
    shift: { id: string; branchId: string; startedAt: Date },
    windowEnd: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const client = tx ?? prisma;
    const result = await client.transaction.aggregate({
      where: {
        branchId: shift.branchId,
        paymentMethod: 'cash',
        status: 'refunded',
        refundedAt: { gte: shift.startedAt, lte: windowEnd },
        shiftId: { not: shift.id },
      },
      _sum: { totalAmount: true },
    });
    return result._sum.totalAmount ?? new Prisma.Decimal(0);
  },

  /** Any transaction at all (regardless of status) counts toward the void guard — even a voided one means the shift wasn't untouched. */
  countAnyTransactionsForShift(shiftId: string) {
    return prisma.transaction.count({ where: { shiftId } });
  },

  /**
   * Requires an already-open transaction client rather than opening its own
   * (contrast createShift/closeAutoShift above) — the caller (cashService.closeShift)
   * owns the transaction boundary so the sales-total reads it does just before
   * calling this can share the same snapshot as this write, closing the race
   * where a sale lands between summing totals and committing the close.
   */
  async closeShift(
    id: string,
    data: CloseShiftData,
    computed: {
      closingCashAmount: number;
      expectedClosingCash: number;
      cashVariance: number;
      cashSalesTotal: number;
      gcashSalesTotal: number;
      mayaSalesTotal: number;
      otherSalesTotal: number;
      grossSalesTotal: number;
      transactionCount: number;
      cashSalesCount: number;
      gcashSalesCount: number;
      mayaSalesCount: number;
      otherSalesCount: number;
      voidedCount: number;
      refundedCount: number;
      totalTransactionCount: number;
      totalDiscountAmount: number;
      pwdScTransactionCount: number;
      status: 'closed' | 'flagged';
      varianceApproved: boolean | null;
      closedBy: string;
    },
    tx: Prisma.TransactionClient,
  ) {
    await tx.shiftCashDenomination.createMany({
      data: data.denominations.map((d) => denominationRow(id, d, 'closing')),
    });

    return tx.shift.update({
      where: { id },
      data: {
        closingCashAmount: computed.closingCashAmount,
        expectedClosingCash: computed.expectedClosingCash,
        cashVariance: computed.cashVariance,
        cashSalesTotal: computed.cashSalesTotal,
        gcashSalesTotal: computed.gcashSalesTotal,
        mayaSalesTotal: computed.mayaSalesTotal,
        otherSalesTotal: computed.otherSalesTotal,
        grossSalesTotal: computed.grossSalesTotal,
        transactionCount: computed.transactionCount,
        cashSalesCount: computed.cashSalesCount,
        gcashSalesCount: computed.gcashSalesCount,
        mayaSalesCount: computed.mayaSalesCount,
        otherSalesCount: computed.otherSalesCount,
        voidedCount: computed.voidedCount,
        refundedCount: computed.refundedCount,
        totalTransactionCount: computed.totalTransactionCount,
        totalDiscountAmount: computed.totalDiscountAmount,
        pwdScTransactionCount: computed.pwdScTransactionCount,
        status: computed.status,
        varianceApproved: computed.varianceApproved,
        varianceExplanation: data.varianceExplanation,
        shiftNotes: data.notes,
        closedBy: computed.closedBy,
        closedAt: new Date(),
      },
      include: shiftInclude,
    });
  },

  approveVariance(id: string, data: { approved: boolean; notes: string; approvedBy: string }) {
    return prisma.shift.update({
      where: { id },
      data: {
        varianceApproved: data.approved,
        varianceApprovedBy: data.approvedBy,
        varianceApprovalReason: data.notes,
        status: 'closed',
      },
      include: shiftInclude,
    });
  },

  voidShift(id: string, data: { voidedBy: string; note: string }) {
    return prisma.shift.update({
      where: { id },
      data: {
        status: 'closed',
        closedBy: data.voidedBy,
        closedAt: new Date(),
        shiftNotes: data.note,
      },
      include: shiftInclude,
    });
  },

  async listShifts(filters: ShiftListFilters) {
    const where: Prisma.ShiftWhereInput = {
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(filters.status && { status: filters.status }),
    };

    const [shifts, total] = await Promise.all([
      prisma.shift.findMany({
        where,
        include: shiftInclude,
        orderBy: { startedAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.shift.count({ where }),
    ]);

    return { shifts, total };
  },

  /** Distinct cashiers who closed a shift in the window — the candidate set rule 3 (cash variance pattern) checks. */
  async findCashiersWithClosedShifts(branchId: string, dayStart: Date, dayEnd: Date): Promise<string[]> {
    const rows = await prisma.shift.findMany({
      where: { branchId, status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: { cashierId: true },
      distinct: ['cashierId'],
    });
    return rows.map((row) => row.cashierId);
  },

  /**
   * EOD summary's "unresolved cash variances" figure (Phase 18 Task 7) —
   * a flagged shift's varianceApproved is null until approveVariance runs,
   * which also flips status back to 'closed', so status === 'flagged' is
   * an equivalent, clearer predicate than filtering on varianceApproved.
   */
  countUnresolvedVariancesInWindow(dayStart: Date, dayEnd: Date) {
    return prisma.shift.count({ where: { status: 'flagged', closedAt: { gte: dayStart, lte: dayEnd } } });
  },

  /** The trailing window rule 3 evaluates: varianceApproved !== null (Decision 6) means "outside tolerance, required a decision". */
  findLastNClosedShiftsForCashier(cashierId: string, branchId: string, n: number) {
    return prisma.shift.findMany({
      where: { cashierId, branchId, status: { in: ['closed', 'flagged'] } },
      orderBy: { closedAt: 'desc' },
      take: n,
      select: { id: true, varianceApproved: true, closedAt: true },
    });
  },

  /** Both phase rows for one shift (createShift always creates exactly two — see the schema comment). */
  listReviewsForShift(shiftId: string) {
    return prisma.shiftReview.findMany({ where: { shiftId }, orderBy: { phase: 'asc' } });
  },

  findReview(shiftId: string, phase: 'opening' | 'closing') {
    return prisma.shiftReview.findUnique({ where: { shiftId_phase: { shiftId, phase } } });
  },

  submitReview(shiftId: string, phase: 'opening' | 'closing', data: { approved: boolean; notes: string; reviewedBy: string }) {
    return prisma.shiftReview.update({
      where: { shiftId_phase: { shiftId, phase } },
      data: {
        status: data.approved ? 'approved' : 'rejected',
        reviewedBy: data.reviewedBy,
        reviewedAt: new Date(),
        notes: data.notes,
      },
    });
  },

  /** Pending-review queue across branches — the list view backing the new Shift Approval UI. */
  async listPendingReviews(filters: { branchId?: string; phase?: 'opening' | 'closing'; page: number; limit: number }) {
    const where: Prisma.ShiftReviewWhereInput = {
      status: 'pending',
      ...(filters.phase && { phase: filters.phase }),
      ...(filters.branchId && { shift: { branchId: filters.branchId } }),
    };

    const [reviews, total] = await Promise.all([
      prisma.shiftReview.findMany({
        where,
        include: { shift: { select: { id: true, branchId: true, cashierId: true, status: true, startedAt: true, closedAt: true } } },
        orderBy: { createdAt: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.shiftReview.count({ where }),
    ]);

    return { reviews, total };
  },
};

function denominationRow(shiftId: string, d: DenominationCountInput, countType: 'opening' | 'closing') {
  return {
    shiftId,
    denomination: d.denomination,
    count: d.quantity,
    totalValue: d.denomination * d.quantity,
    countType,
  };
}
