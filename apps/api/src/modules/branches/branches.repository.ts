import type { Prisma } from '@prisma/client';
import { PAYMENT_METHOD, type PaymentMethod } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { nextCounterValue } from '../../lib/id-counter.js';
import { dayBounds } from '../../lib/manila-time.js';
import { computeFinancialMetrics } from '../../lib/financial-metrics.js';
import { computeCogsForItems } from '../../lib/cogs.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import type { BranchListFilters, CreateBranchData, UpdateBranchData } from './branches.types.js';

function emptyPaymentBreakdown(): Record<PaymentMethod, { total: number; count: number }> {
  return Object.fromEntries(
    Object.values(PAYMENT_METHOD).map((method) => [method, { total: 0, count: 0 }]),
  ) as Record<PaymentMethod, { total: number; count: number }>;
}

const activeAssignmentsInclude = {
  userAssignments: {
    where: { removedAt: null },
    select: {
      id: true,
      userId: true,
      branchId: true,
      assignedAt: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
    },
  },
} satisfies Prisma.BranchInclude;

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function buildWhere(filters: Pick<BranchListFilters, 'status' | 'city' | 'search' | 'ids'>): Prisma.BranchWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.city && { city: { contains: filters.city, mode: 'insensitive' } }),
    ...(filters.ids && { id: { in: filters.ids } }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { code: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  };
}

/**
 * Branches repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const branchesRepository = {
  async findAll(filters: BranchListFilters) {
    const where = buildWhere(filters);

    const [branches, total] = await Promise.all([
      prisma.branch.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        include: activeAssignmentsInclude,
      }),
      prisma.branch.count({ where }),
    ]);

    return { branches, total };
  },

  findById(id: string) {
    return prisma.branch.findUnique({
      where: { id },
      include: activeAssignmentsInclude,
    });
  },

  findByIds(ids: string[]) {
    return prisma.branch.findMany({
      where: { id: { in: ids } },
      include: activeAssignmentsInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  findByCode(code: string) {
    return prisma.branch.findUnique({ where: { code } });
  },

  /**
   * CR-005 Sub-phase 3a — every branch's id, for flavor-ingredient fan-out
   * provisioning (flavorsService createFlavor/updateFlavor). Branch has no
   * soft-delete column (deletedAt) — only a status field — so "every
   * existing branch" here is every row, unfiltered by status: an inactive
   * branch should still have the Ingredient identity ready for when it
   * reactivates, same reasoning as CR-004's provisionBranchIngredients
   * firing on branch creation regardless of status.
   */
  async listAllBranchIds(): Promise<string[]> {
    const branches = await prisma.branch.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return branches.map((b) => b.id);
  },

  /**
   * The database is the source of truth for Supervisor branch access
   * (branch-access.ts's getAccessibleBranchIds) — this Supervisor's
   * currently-active UserBranchAssignment rows, queried fresh on every call
   * so an assignment added/removed by an Admin, or a branch that goes
   * inactive, takes effect immediately without a relogin. A Supervisor with
   * zero active assignments correctly gets back an empty array (fail-closed
   * — see branch-access.ts), never every branch.
   */
  async findAllActiveBranchIds(userId: string): Promise<string[]> {
    const assignments = await prisma.userBranchAssignment.findMany({
      where: { userId, removedAt: null, branch: { status: 'active' } },
      select: { branchId: true },
      orderBy: { assignedAt: 'asc' },
    });
    return assignments.map((a) => a.branchId);
  },

  /**
   * Transfer-destination candidates (Transfer RBAC policy): active branches
   * other than the source, optionally restricted to a specific id allowlist
   * (supervisor scope, from getTransferDestinationBranchIds). Powers the
   * "Destination Branch" picker so it only ever offers what the backend
   * would actually accept from transferStock.
   */
  async findActiveBranchesForTransfer(excludeBranchId: string, restrictToIds?: string[]): Promise<{ id: string; name: string; code: string }[]> {
    return prisma.branch.findMany({
      where: {
        status: 'active',
        id: { not: excludeBranchId, ...(restrictToIds ? { in: restrictToIds } : {}) },
      },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    });
  },

  create(data: CreateBranchData, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).branch.create({
      data: {
        name: data.name,
        code: data.code as string,
        address: data.address,
        city: data.city,
        gpsLatitude: data.gpsLatitude,
        gpsLongitude: data.gpsLongitude,
        gpsRadiusMeters: data.gpsRadiusMeters,
        status: data.status,
      },
      include: activeAssignmentsInclude,
    });
  },

  update(id: string, data: UpdateBranchData) {
    return prisma.branch.update({
      where: { id },
      data,
      include: activeAssignmentsInclude,
    });
  },

  getActiveAssignments(branchId: string) {
    return prisma.userBranchAssignment.findMany({
      where: { branchId, removedAt: null },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } } },
      orderBy: { assignedAt: 'desc' },
    });
  },

  findActiveAssignment(userId: string, branchId: string) {
    return prisma.userBranchAssignment.findFirst({
      where: { userId, branchId, removedAt: null },
    });
  },

  assignUser(userId: string, branchId: string) {
    return prisma.userBranchAssignment.create({
      data: { userId, branchId, assignedAt: new Date(), removedAt: null },
    });
  },

  removeUserAssignment(assignmentId: string) {
    return prisma.userBranchAssignment.update({
      where: { id: assignmentId },
      data: { removedAt: new Date() },
    });
  },

  getUserActiveBranches(userId: string) {
    return prisma.userBranchAssignment.findMany({
      where: { userId, removedAt: null },
      include: { branch: true },
    });
  },

  findUserById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  countActiveShifts(branchId: string) {
    return prisma.shift.count({ where: { branchId, status: 'active' } });
  },

  delete(branchId: string) {
    return prisma.branch.delete({ where: { id: branchId } });
  },

  async branchStats(branchId: string) {
    const { dayStart, dayEnd } = dayBounds(new Date());
    const todayRange = { gte: dayStart, lte: dayEnd };

    const [
      activeShiftsCount,
      todayTransactions,
      todayRefunds,
      paymentGroups,
      todayTransactionItems,
      activeStaffCount,
      staffTimedInCount,
      todayExpenses,
      ingredients,
    ] = await Promise.all([
      prisma.shift.count({ where: { branchId, status: 'active' } }),
      prisma.transaction.aggregate({
        where: { branchId, createdAt: todayRange, status: 'completed' },
        _count: { _all: true },
        _sum: { subtotal: true, discountAmount: true, vatAmount: true },
      }),
      prisma.transaction.aggregate({
        where: { branchId, createdAt: todayRange, status: 'refunded' },
        _sum: { totalAmount: true },
      }),
      prisma.transaction.groupBy({
        by: ['paymentMethod'],
        where: { branchId, createdAt: todayRange, status: 'completed' },
        // subtotal, not totalAmount — must match todayGrossSales's field exactly
        // (same where-clause too) so Σ(paymentBreakdown) === todayGrossSales.
        _sum: { subtotal: true },
        _count: { _all: true },
      }),
      prisma.transactionItem.findMany({
        where: { transaction: { branchId, createdAt: todayRange, status: 'completed' } },
        select: { deductionSnapshot: true },
      }),
      prisma.userBranchAssignment.count({
        where: { branchId, removedAt: null, user: { role: 'staff' } },
      }),
      // Currently timed-in staff (Simple Operational Audit §7) — a live
      // "right now" count, deliberately not scoped to today's Manila window
      // since a clock-in can span midnight.
      prisma.attendanceRecord.count({
        where: { branchId, clockOutServerTime: null, deletedAt: null },
      }),
      prisma.expense.aggregate({
        where: { branchId, deletedAt: null, incurredAt: todayRange },
        _sum: { amount: true },
      }),
      // Prisma's filter API can't compare two columns of the same row
      // (currentStock <= lowStockThreshold) without raw SQL, which this
      // project avoids — branch ingredient lists are small, so counting
      // in application code is simpler and stays within the ORM.
      //
      // currentStock itself is no longer read here (Phase 8: it's a
      // vestigial stored field, never updated after ingredient creation —
      // see the schema doc comment on Ingredient). Real current stock is
      // derived from the InventoryMovement ledger via inventoryRepository,
      // the same source every Phase 8 endpoint uses.
      prisma.ingredient.findMany({
        where: { branchId, deletedAt: null },
        select: { id: true, lowStockThreshold: true },
      }),
    ]);

    // getCurrentStockMap only includes ingredients with at least one
    // movement — one with none has zero stock, not "unknown," so it must
    // still count toward the low-stock total whenever the threshold is >= 0.
    const stockMap = await inventoryRepository.getCurrentStockMap(ingredients.map((i) => i.id));
    const lowStockIngredientCount = ingredients.filter((ingredient) => {
      const currentStock = stockMap.get(ingredient.id)?.toNumber() ?? 0;
      return currentStock <= ingredient.lowStockThreshold.toNumber();
    }).length;

    const { cogs, isEstimated, missingCostItemCount } = await computeCogsForItems(
      todayTransactionItems.map((item) => ({ branchId, deductionSnapshot: item.deductionSnapshot })),
    );

    const metrics = computeFinancialMetrics({
      grossSales: Number(todayTransactions._sum.subtotal ?? 0),
      discountTotal: Number(todayTransactions._sum.discountAmount ?? 0),
      refundTotal: Number(todayRefunds._sum.totalAmount ?? 0),
      cogs,
      expenseTotal: Number(todayExpenses._sum.amount ?? 0),
    });

    const paymentBreakdown = emptyPaymentBreakdown();
    for (const group of paymentGroups) {
      paymentBreakdown[group.paymentMethod] = {
        total: round2(Number(group._sum.subtotal ?? 0)),
        count: group._count._all,
      };
    }

    return {
      activeShiftsCount,
      todayTransactionCount: todayTransactions._count._all,
      todayGrossSales: metrics.grossSales,
      todayDiscountTotal: metrics.discountTotal,
      todayRefundTotal: metrics.refundTotal,
      todayNetSales: metrics.netSales,
      todayVat: Number(todayTransactions._sum.vatAmount ?? 0),
      todayCogs: metrics.cogs,
      todayGrossProfit: metrics.grossProfit,
      todayExpenses: metrics.expenseTotal,
      todayNetProfit: metrics.netProfit,
      isNetProfitEstimated: isEstimated,
      missingCostItemCount,
      paymentBreakdown,
      activeStaffCount,
      staffTimedInCount,
      lowStockIngredientCount,
    };
  },

  async findAllAccounts() {
    return prisma.userBranchAssignment.findMany({
      where: { removedAt: null, user: { role: 'branch' } },
      select: {
        id: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ branch: { name: 'asc' } }, { user: { lastName: 'asc' } }],
    });
  },

  /**
   * Per-branch stats, one row per active branch, same formulas/Manila
   * window as branchStats() — the admin dashboard sums these rows client
   * side, so each field here must already be branch-scoped and non-
   * overlapping (no branch's transactions/expenses/items counted under
   * another branch) for that consolidation to avoid double counting.
   */
  async findAllStatsGrouped() {
    const { dayStart, dayEnd } = dayBounds(new Date());
    const todayRange = { gte: dayStart, lte: dayEnd };

    const [
      branches,
      shiftGroups,
      staffGroups,
      staffTimedInGroups,
      txnGroups,
      refundGroups,
      paymentGroups,
      todayTransactionItems,
      expenseGroups,
      ingredients,
    ] = await Promise.all([
      prisma.branch.findMany({
        where: { status: 'active' },
        select: { id: true },
      }),
      prisma.shift.groupBy({
        by: ['branchId'],
        where: { status: 'active' },
        _count: { _all: true },
      }),
      prisma.userBranchAssignment.groupBy({
        by: ['branchId'],
        where: { removedAt: null, user: { role: 'staff' } },
        _count: { _all: true },
      }),
      prisma.attendanceRecord.groupBy({
        by: ['branchId'],
        where: { clockOutServerTime: null, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.transaction.groupBy({
        by: ['branchId'],
        where: { status: 'completed', createdAt: todayRange },
        _sum: { subtotal: true, discountAmount: true, vatAmount: true },
        _count: { _all: true },
      }),
      prisma.transaction.groupBy({
        by: ['branchId'],
        where: { status: 'refunded', createdAt: todayRange },
        _sum: { totalAmount: true },
      }),
      prisma.transaction.groupBy({
        by: ['branchId', 'paymentMethod'],
        where: { status: 'completed', createdAt: todayRange },
        // subtotal, not totalAmount — must match todayGrossSales's field exactly
        // (same where-clause too) so Σ(paymentBreakdown) === todayGrossSales.
        _sum: { subtotal: true },
        _count: { _all: true },
      }),
      prisma.transactionItem.findMany({
        where: { transaction: { status: 'completed', createdAt: todayRange } },
        select: { deductionSnapshot: true, transaction: { select: { branchId: true } } },
      }),
      prisma.expense.groupBy({
        by: ['branchId'],
        where: { deletedAt: null, incurredAt: todayRange },
        _sum: { amount: true },
      }),
      prisma.ingredient.findMany({
        where: { deletedAt: null },
        select: { id: true, branchId: true, lowStockThreshold: true },
      }),
    ]);

    const stockMap = await inventoryRepository.getCurrentStockMap(ingredients.map((i) => i.id));
    const lowStockByBranch = new Map<string, number>();
    for (const ing of ingredients) {
      const current = stockMap.get(ing.id)?.toNumber() ?? 0;
      if (current <= ing.lowStockThreshold.toNumber()) {
        lowStockByBranch.set(ing.branchId, (lowStockByBranch.get(ing.branchId) ?? 0) + 1);
      }
    }

    const itemsByBranch = new Map<string, { branchId: string; deductionSnapshot: Prisma.JsonValue | null }[]>();
    for (const item of todayTransactionItems) {
      const branchId = item.transaction.branchId;
      const list = itemsByBranch.get(branchId) ?? [];
      list.push({ branchId, deductionSnapshot: item.deductionSnapshot });
      itemsByBranch.set(branchId, list);
    }

    const cogsByBranch = new Map<string, Awaited<ReturnType<typeof computeCogsForItems>>>();
    await Promise.all(
      branches.map(async (b) => {
        cogsByBranch.set(b.id, await computeCogsForItems(itemsByBranch.get(b.id) ?? []));
      }),
    );

    return branches.map((b) => {
      const txnGroup = txnGroups.find((g) => g.branchId === b.id);
      const { cogs, isEstimated, missingCostItemCount } = cogsByBranch.get(b.id) ?? {
        cogs: 0,
        isEstimated: false,
        missingCostItemCount: 0,
      };

      const metrics = computeFinancialMetrics({
        grossSales: Number(txnGroup?._sum.subtotal ?? 0),
        discountTotal: Number(txnGroup?._sum.discountAmount ?? 0),
        refundTotal: Number(refundGroups.find((g) => g.branchId === b.id)?._sum.totalAmount ?? 0),
        cogs,
        expenseTotal: Number(expenseGroups.find((g) => g.branchId === b.id)?._sum.amount ?? 0),
      });

      const paymentBreakdown = emptyPaymentBreakdown();
      for (const group of paymentGroups.filter((g) => g.branchId === b.id)) {
        paymentBreakdown[group.paymentMethod] = {
          total: round2(Number(group._sum.subtotal ?? 0)),
          count: group._count._all,
        };
      }

      return {
        branchId: b.id,
        activeShiftsCount: shiftGroups.find((g) => g.branchId === b.id)?._count._all ?? 0,
        activeStaffCount: staffGroups.find((g) => g.branchId === b.id)?._count._all ?? 0,
        staffTimedInCount: staffTimedInGroups.find((g) => g.branchId === b.id)?._count._all ?? 0,
        todayTransactionCount: txnGroup?._count._all ?? 0,
        todayGrossSales: metrics.grossSales,
        todayDiscountTotal: metrics.discountTotal,
        todayRefundTotal: metrics.refundTotal,
        todayNetSales: metrics.netSales,
        todayVat: Number(txnGroup?._sum.vatAmount ?? 0),
        todayCogs: metrics.cogs,
        todayGrossProfit: metrics.grossProfit,
        todayExpenses: metrics.expenseTotal,
        todayNetProfit: metrics.netProfit,
        isNetProfitEstimated: isEstimated,
        missingCostItemCount,
        paymentBreakdown,
        lowStockIngredientCount: lowStockByBranch.get(b.id) ?? 0,
      };
    });
  },

  /**
   * Atomically allocates the next branch number for a city prefix — two
   * concurrent requests can never receive the same number because the
   * underlying INSERT ... ON CONFLICT is a single atomic statement
   * server-side (Phase 21: Postgres replacement for Redis INCR). One
   * counter row per city prefix (created on first use).
   */
  async generateBranchCode(city: string): Promise<string> {
    const citySlug = city
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 3);
    const key = `branch_code_counter:${citySlug}`;
    const next = await nextCounterValue(key);
    return `PC-${citySlug}-${String(next).padStart(3, '0')}`;
  },
};
