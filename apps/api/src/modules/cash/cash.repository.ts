import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CloseShiftData, DenominationCountInput, OpenShiftData, ShiftListFilters, ShiftCloseComputedCounts } from './cash.types.js';

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

  /** Whether *any* shift is currently open at a branch — used by GET /current and the open-shift 409 guard. */
  findActiveShiftByBranch(branchId: string) {
    return prisma.shift.findFirst({
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

      return tx.shift.findUniqueOrThrow({ where: { id: shift.id }, include: shiftInclude });
    });
  },

  /**
   * Aggregates completed-transaction sales for a shift, split by payment
   * method — voided/refunded transactions never touched the physical
   * drawer, so they're excluded from cash_sales_total on purpose.
   */
  async sumTransactionsForShift(shiftId: string): Promise<{ cashSalesTotal: Prisma.Decimal; gcashSalesTotal: Prisma.Decimal; transactionCount: number }> {
    const rows = await prisma.transaction.groupBy({
      by: ['paymentMethod'],
      where: { shiftId, status: 'completed' },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });

    const cashRow = rows.find((r) => r.paymentMethod === 'cash');
    const gcashRow = rows.find((r) => r.paymentMethod === 'gcash');

    return {
      cashSalesTotal: cashRow?._sum.totalAmount ?? new Prisma.Decimal(0),
      gcashSalesTotal: gcashRow?._sum.totalAmount ?? new Prisma.Decimal(0),
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
  async sumTransactionCountsForShift(shiftId: string): Promise<ShiftCloseComputedCounts> {
    const [statusRows, discountAgg, pwdScCount, totalCount] = await Promise.all([
      prisma.transaction.groupBy({
        by: ['paymentMethod', 'status'],
        where: { shiftId },
        _count: { _all: true },
      }),
      prisma.transaction.aggregate({
        where: { shiftId, status: 'completed' },
        _sum: { discountAmount: true },
      }),
      prisma.transaction.count({
        where: { shiftId, status: 'completed', discountType: { in: ['pwd', 'senior_citizen'] } },
      }),
      prisma.transaction.count({ where: { shiftId } }),
    ]);

    const cashSalesCount = statusRows.find((r) => r.paymentMethod === 'cash' && r.status === 'completed')?._count._all ?? 0;
    const gcashSalesCount = statusRows.find((r) => r.paymentMethod === 'gcash' && r.status === 'completed')?._count._all ?? 0;
    const voidedCount = statusRows.filter((r) => r.status === 'voided').reduce((sum, r) => sum + r._count._all, 0);
    const refundedCount = statusRows.filter((r) => r.status === 'refunded').reduce((sum, r) => sum + r._count._all, 0);

    return {
      cashSalesCount,
      gcashSalesCount,
      voidedCount,
      refundedCount,
      totalTransactionCount: totalCount,
      totalDiscountAmount: discountAgg._sum.discountAmount?.toNumber() ?? 0,
      pwdScTransactionCount: pwdScCount,
    };
  },

  /** Any transaction at all (regardless of status) counts toward the void guard — even a voided one means the shift wasn't untouched. */
  countAnyTransactionsForShift(shiftId: string) {
    return prisma.transaction.count({ where: { shiftId } });
  },

  async closeShift(
    id: string,
    data: CloseShiftData,
    computed: {
      closingCashAmount: number;
      expectedClosingCash: number;
      cashVariance: number;
      cashSalesTotal: number;
      gcashSalesTotal: number;
      transactionCount: number;
      cashSalesCount: number;
      gcashSalesCount: number;
      voidedCount: number;
      refundedCount: number;
      totalTransactionCount: number;
      totalDiscountAmount: number;
      pwdScTransactionCount: number;
      status: 'closed' | 'flagged';
      varianceApproved: boolean | null;
      closedBy: string;
    },
  ) {
    return prisma.$transaction(async (tx) => {
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
          transactionCount: computed.transactionCount,
          cashSalesCount: computed.cashSalesCount,
          gcashSalesCount: computed.gcashSalesCount,
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

  /** The trailing window rule 3 evaluates: varianceApproved !== null (Decision 6) means "outside tolerance, required a decision". */
  findLastNClosedShiftsForCashier(cashierId: string, branchId: string, n: number) {
    return prisma.shift.findMany({
      where: { cashierId, branchId, status: { in: ['closed', 'flagged'] } },
      orderBy: { closedAt: 'desc' },
      take: n,
      select: { id: true, varianceApproved: true, closedAt: true },
    });
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
