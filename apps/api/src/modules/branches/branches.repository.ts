import type { Prisma } from '@prisma/client';
import { MANUAL_TOTAL_CALCULATION, PAYMENT_METHOD, type PaymentMethod } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { lockNonRemovedUser } from '../employees/employees.repository.js';
import { nextCounterValue } from '../../lib/id-counter.js';
import { dayBounds, manilaDateKey } from '../../lib/manila-time.js';
import { REMOVED_ACCOUNT_MARKER_TTL_MS, removedAccountRevocationHash } from '../../lib/verify-access-token.js';
import { computeFinancialMetrics } from '../../lib/financial-metrics.js';
import { availableStock, classifyStockStatus } from '../universal-inventory/stock-classification.js';
import type {
  BranchActivityFingerprint,
  BranchDeletionBlocker,
  BranchDeletionOutcome,
  BranchListFilters,
  CreateBranchData,
  UpdateBranchData,
} from './branches.types.js';

function emptyPaymentBreakdown(): Record<PaymentMethod, { total: number; count: number }> {
  return Object.fromEntries(
    Object.values(PAYMENT_METHOD).map((method) => [method, { total: 0, count: 0 }]),
  ) as Record<PaymentMethod, { total: number; count: number }>;
}

interface CalculationModeGroup {
  calculationMode: string | null;
  _sum: { vatAmount: Prisma.Decimal | null; totalAmount: Prisma.Decimal | null };
  _count: { _all: number };
}

/**
 * POS-PERF-P55R3 — today's VAT of the VAT-calculated sales only (NULL = recorded
 * before P55R2), with the manual-total sales counted apart: their stored 0 VAT
 * is a placeholder for "VAT not calculated", never a ₱0 VAT result.
 */
function vatCoverage(groups: CalculationModeGroup[]) {
  let vat = 0;
  let notCalculatedCount = 0;
  let notCalculatedSales = 0;
  for (const group of groups) {
    if (group.calculationMode === MANUAL_TOTAL_CALCULATION) {
      notCalculatedCount += group._count._all;
      notCalculatedSales += Number(group._sum.totalAmount ?? 0);
    } else {
      vat += Number(group._sum.vatAmount ?? 0);
    }
  }
  return { todayVat: round2(vat), todayTaxNotCalculatedCount: notCalculatedCount, todayTaxNotCalculatedSales: round2(notCalculatedSales) };
}

/**
 * Canonical count of items needing attention at one branch, sourced from
 * InventoryStock (Phase 4 dashboard KPI reconciliation) instead of the legacy
 * Ingredient/InventoryMovement ledger. POS-PERF-P56 — the same rule as the
 * Inventory page's "Needs attention" filter (classifyStockStatus on available
 * stock, tracked items only), so a zero-stock item without thresholds counts.
 */
function needsAttention(row: {
  quantityOnHand: { toNumber(): number };
  quantityReserved: { toNumber(): number };
  lowStockThreshold: { toNumber(): number } | null;
  criticalThreshold: { toNumber(): number } | null;
}): boolean {
  const available = availableStock(row.quantityOnHand.toNumber(), row.quantityReserved.toNumber());
  return classifyStockStatus(available, row.lowStockThreshold?.toNumber() ?? null, row.criticalThreshold?.toNumber() ?? null) !== 'healthy';
}

async function countLowStock(branchId: string): Promise<number> {
  const rows = await prisma.inventoryStock.findMany({
    where: { branchId, inventoryItem: { deletedAt: null, trackInventory: true } },
    select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true, criticalThreshold: true },
  });
  return rows.filter(needsAttention).length;
}

/** Same rule as countLowStock, grouped across every active branch in one query — used by findAllStatsGrouped. */
async function countLowStockByBranch(branchIds: string[]): Promise<Map<string, number>> {
  const rows = await prisma.inventoryStock.findMany({
    where: { branchId: { in: branchIds }, inventoryItem: { deletedAt: null, trackInventory: true } },
    select: { branchId: true, quantityOnHand: true, quantityReserved: true, lowStockThreshold: true, criticalThreshold: true },
  });
  const byBranch = new Map<string, number>();
  for (const row of rows) {
    if (needsAttention(row)) {
      byBranch.set(row.branchId, (byBranch.get(row.branchId) ?? 0) + 1);
    }
  }
  return byBranch;
}

/**
 * Canonical "currently working" count for the live Staff Clocked In KPI
 * (Cross-Dashboard Correctness audit). An open attendance row
 * (clock_out_server_time IS NULL) only counts a staff member as currently
 * working if the employee is still active AND still holds a live
 * (non-removed) assignment to the same branch they clocked in at — this
 * excludes terminated/deactivated staff and staff reassigned elsewhere
 * without ever modifying the underlying attendance row. Historical/stale
 * open attendance remains queryable on the attendance pages; it just no
 * longer inflates this live KPI.
 */
async function countStaffTimedIn(branchId: string): Promise<number> {
  const rows = await prisma.attendanceRecord.findMany({
    where: { branchId, clockOutServerTime: null, deletedAt: null },
    select: {
      // POS-PERF-P66 — live account fields through Person.account (null once deleted, which counts as not working).
      employee: {
        select: {
          account: { select: { isActive: true, status: true, branchAssignments: { where: { branchId, removedAt: null }, select: { id: true } } } },
        },
      },
    },
  });
  return rows.filter(
    (row) => row.employee.account?.isActive === true && row.employee.account.status === 'active' && row.employee.account.branchAssignments.length > 0,
  ).length;
}

/** Same rule as countStaffTimedIn, grouped across every branch in one query — used by findAllStatsGrouped. */
async function countStaffTimedInByBranch(): Promise<Map<string, number>> {
  const rows = await prisma.attendanceRecord.findMany({
    where: { clockOutServerTime: null, deletedAt: null },
    select: {
      branchId: true,
      employee: {
        select: {
          account: { select: { isActive: true, status: true, branchAssignments: { where: { removedAt: null }, select: { branchId: true } } } },
        },
      },
    },
  });
  const byBranch = new Map<string, number>();
  for (const row of rows) {
    const account = row.employee.account;
    const isCurrentlyWorking =
      account !== null &&
      account.isActive &&
      account.status === 'active' &&
      account.branchAssignments.some((a) => a.branchId === row.branchId);
    if (isCurrentlyWorking) {
      byBranch.set(row.branchId, (byBranch.get(row.branchId) ?? 0) + 1);
    }
  }
  return byBranch;
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
  /** `client`: POS-PERF-P38R2 publication re-checks assignments through its transaction client. */
  async findAllActiveBranchIds(userId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<string[]> {
    const assignments = await client.userBranchAssignment.findMany({
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

  /** POS-PERF-P64 — under the user's row lock, so a concurrent removal cannot be followed by a fresh assignment. */
  assignUser(userId: string, branchId: string) {
    return prisma.$transaction(async (tx) => {
      await lockNonRemovedUser(tx, userId);
      return tx.userBranchAssignment.create({
        data: { userId, branchId, assignedAt: new Date(), removedAt: null },
      });
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

  /** The canonical role='branch' login account(s) currently active for this branch — see changeBranchStatus's operational-status sync. */
  findActiveBranchAccountUsers(branchId: string) {
    return prisma.user.findMany({
      where: {
        role: 'branch',
        isActive: true,
        branchAssignments: { some: { branchId, removedAt: null } },
      },
      select: { id: true, email: true },
    });
  },


  async branchStats(branchId: string) {
    const { dayStart, dayEnd } = dayBounds(new Date());
    const todayRange = { gte: dayStart, lte: dayEnd };

    const [
      activeShiftsCount,
      todayTransactions,
      calculationModeGroups,
      todayRefunds,
      paymentGroups,
      activeStaffCount,
      staffTimedInCount,
      todayExpenses,
      lowStockIngredientCount,
    ] = await Promise.all([
      prisma.shift.count({ where: { branchId, status: 'active' } }),
      prisma.transaction.aggregate({
        where: { branchId, createdAt: todayRange, status: 'completed' },
        _count: { _all: true },
        _sum: { subtotal: true, discountAmount: true },
      }),
      prisma.transaction.groupBy({
        by: ['calculationMode'],
        where: { branchId, createdAt: todayRange, status: 'completed' },
        _sum: { vatAmount: true, totalAmount: true },
        _count: { _all: true },
      }),
      prisma.transaction.aggregate({
        where: { branchId, createdAt: todayRange, status: 'refunded' },
        _sum: { totalAmount: true },
      }),
      prisma.transaction.groupBy({
        by: ['paymentMethod'],
        where: { branchId, createdAt: todayRange, status: 'completed' },
        // Phase 5 (Payment Collections KPI reconciliation): totalAmount, not
        // subtotal — Payment Collections must reflect what was actually
        // collected from the customer (post-discount), same canonical field
        // reportsRepository.getPaymentMethodMix already uses. This
        // deliberately no longer sums to todayGrossSales (which stays
        // subtotal/pre-discount) whenever a branch has discounted sales —
        // that divergence is the correct, intended behavior, not a bug.
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      prisma.userBranchAssignment.count({
        where: { branchId, removedAt: null, user: { role: 'staff' } },
      }),
      // Currently timed-in staff (Simple Operational Audit §7) — a live
      // "right now" count, deliberately not scoped to today's Manila window
      // since a clock-in can span midnight. See countStaffTimedIn for the
      // "currently working" definition (excludes terminated/unassigned staff).
      countStaffTimedIn(branchId),
      prisma.expense.aggregate({
        where: { branchId, deletedAt: null, incurredAt: todayRange },
        _sum: { amount: true },
      }),
      // Phase 4 dashboard KPI reconciliation: canonical InventoryStock-based
      // count (see countLowStock above), not the legacy Ingredient +
      // InventoryMovement ledger.
      countLowStock(branchId),
    ]);

    // P2 Canonical Finance Simplification: no COGS input — inventory cost is
    // not part of this financial model (see lib/financial-metrics.ts).
    const metrics = computeFinancialMetrics({
      grossSales: Number(todayTransactions._sum.subtotal ?? 0),
      discountTotal: Number(todayTransactions._sum.discountAmount ?? 0),
      refundTotal: Number(todayRefunds._sum.totalAmount ?? 0),
      expenseTotal: Number(todayExpenses._sum.amount ?? 0),
    });

    const paymentBreakdown = emptyPaymentBreakdown();
    for (const group of paymentGroups) {
      paymentBreakdown[group.paymentMethod] = {
        total: round2(Number(group._sum.totalAmount ?? 0)),
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
      ...vatCoverage(calculationModeGroups),
      todayExpenses: metrics.expenseTotal,
      todayNetOperatingResult: metrics.netOperatingResult,
      paymentBreakdown,
      activeStaffCount,
      staffTimedInCount,
      lowStockIngredientCount,
    };
  },

  findAllIds() {
    return prisma.branch.findMany({ select: { id: true } });
  },

  findAllNames() {
    return prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
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
      calculationModeGroups,
      refundGroups,
      paymentGroups,
      expenseGroups,
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
      countStaffTimedInByBranch(),
      prisma.transaction.groupBy({
        by: ['branchId'],
        where: { status: 'completed', createdAt: todayRange },
        _sum: { subtotal: true, discountAmount: true },
        _count: { _all: true },
      }),
      prisma.transaction.groupBy({
        by: ['branchId', 'calculationMode'],
        where: { status: 'completed', createdAt: todayRange },
        _sum: { vatAmount: true, totalAmount: true },
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
        // Phase 5 (Payment Collections KPI reconciliation): totalAmount, not
        // subtotal — see branchStats's identical comment above.
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      prisma.expense.groupBy({
        by: ['branchId'],
        where: { deletedAt: null, incurredAt: todayRange },
        _sum: { amount: true },
      }),
    ]);

    // Phase 4 dashboard KPI reconciliation: canonical InventoryStock-based
    // count (see countLowStockByBranch above), not the legacy Ingredient +
    // InventoryMovement ledger.
    const lowStockByBranch = await countLowStockByBranch(branches.map((b) => b.id));

    return branches.map((b) => {
      const txnGroup = txnGroups.find((g) => g.branchId === b.id);

      // P2 Canonical Finance Simplification: no COGS input — inventory cost
      // is not part of this financial model (see lib/financial-metrics.ts).
      const metrics = computeFinancialMetrics({
        grossSales: Number(txnGroup?._sum.subtotal ?? 0),
        discountTotal: Number(txnGroup?._sum.discountAmount ?? 0),
        refundTotal: Number(refundGroups.find((g) => g.branchId === b.id)?._sum.totalAmount ?? 0),
        expenseTotal: Number(expenseGroups.find((g) => g.branchId === b.id)?._sum.amount ?? 0),
      });

      const paymentBreakdown = emptyPaymentBreakdown();
      for (const group of paymentGroups.filter((g) => g.branchId === b.id)) {
        paymentBreakdown[group.paymentMethod] = {
          total: round2(Number(group._sum.totalAmount ?? 0)),
          count: group._count._all,
        };
      }

      return {
        branchId: b.id,
        activeShiftsCount: shiftGroups.find((g) => g.branchId === b.id)?._count._all ?? 0,
        activeStaffCount: staffGroups.find((g) => g.branchId === b.id)?._count._all ?? 0,
        staffTimedInCount: staffTimedInGroups.get(b.id) ?? 0,
        todayTransactionCount: txnGroup?._count._all ?? 0,
        todayGrossSales: metrics.grossSales,
        todayDiscountTotal: metrics.discountTotal,
        todayRefundTotal: metrics.refundTotal,
        todayNetSales: metrics.netSales,
        ...vatCoverage(calculationModeGroups.filter((g) => g.branchId === b.id)),
        todayExpenses: metrics.expenseTotal,
        todayNetOperatingResult: metrics.netOperatingResult,
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

  // ---------------------------------------------------------------------
  // POS-PERF-P67 — permanent branch deletion that keeps history.
  // ---------------------------------------------------------------------

  /** The historical record, live or deleted (codes are never reused). */
  findRecordById(branchId: string) {
    return prisma.branchRecord.findUnique({ where: { id: branchId } });
  },

  findRecordByCode(code: string) {
    return prisma.branchRecord.findUnique({ where: { code } });
  },

  /** Ids among `branchIds` whose branch still exists (deleted ones drop out). */
  async findExistingBranchIds(branchIds: string[], client: Prisma.TransactionClient | typeof prisma = prisma): Promise<string[]> {
    if (branchIds.length === 0) return [];
    const rows = await client.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true } });
    return rows.map((row) => row.id);
  },

  /** History that stays with the branch record after deletion. */
  async countRetainedHistory(branchId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<Record<string, number>> {
    const where = { branchId };
    const [
      sales,
      shifts,
      attendance,
      expenses,
      payrollRuns,
      payRates,
      stockMovements,
      legacyMovements,
      costCorrections,
      extraSupplyIssues,
      discountProofs,
      discountTypes,
      auditEntries,
      fraudAlerts,
    ] = await Promise.all([
      client.transaction.count({ where }),
      client.shift.count({ where }),
      client.attendanceRecord.count({ where }),
      client.expense.count({ where }),
      client.payrollRun.count({ where }),
      client.employeePayRate.count({ where }),
      client.inventoryStockMovement.count({ where }),
      client.inventoryMovement.count({ where }),
      client.inventoryCostCorrection.count({ where }),
      client.extraSupplyIssue.count({ where }),
      client.discountProofUpload.count({ where }),
      client.manualDiscountType.count({ where }),
      client.auditLog.count({ where }),
      client.fraudAlert.count({ where }),
    ]);
    return {
      sales,
      shifts,
      attendance,
      expenses,
      payroll_runs: payrollRuns,
      pay_rates: payRates,
      stock_movements: stockMovements,
      legacy_inventory_movements: legacyMovements,
      cost_corrections: costCorrections,
      extra_supply_issues: extraSupplyIssues,
      discount_proofs: discountProofs,
      discount_types: discountTypes,
      audit_entries: auditEntries,
      fraud_alerts: fraudAlerts,
    };
  },

  /** What goes with the branch: its login accounts, everyone's access to it, and its configuration. */
  async countRemovedWithBranch(branchId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<Record<string, number>> {
    const [branchAccountIds, activeAssignments, stockRows, availability, promotions, notifications] = await Promise.all([
      branchesRepository.findBranchAccountIds(branchId, client),
      client.userBranchAssignment.count({ where: { branchId, removedAt: null, user: { role: { not: 'branch' } } } }),
      client.inventoryStock.count({ where: { branchId } }),
      client.branchProductAvailability.count({ where: { branchId } }),
      client.promotionBranch.count({ where: { branchId } }),
      client.notification.count({ where: { branchId } }),
    ]);
    return {
      branch_accounts: branchAccountIds.length,
      staff_and_supervisor_access: activeAssignments,
      zero_stock_rows: stockRows,
      product_availability_settings: availability,
      promotion_enrolments: promotions,
      notifications,
    };
  },

  /** role='branch' login accounts that belong to this branch and to no other live branch. */
  async findBranchAccountIds(branchId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<string[]> {
    const rows = await client.user.findMany({
      where: {
        role: 'branch',
        branchAssignments: { some: { branchId } },
        NOT: { branchAssignments: { some: { branchId: { not: branchId }, removedAt: null } } },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * Open work that deleting the branch would lose or leave uncertain. History
   * never appears here. Each blocker has an existing way to finish it: close
   * the shift, clock out, complete or release the order, let the deduction
   * finish or reconcile it, review the approval, transfer or count stock to
   * zero, finalize or discard payroll.
   */
  async findDeletionBlockers(branchId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<BranchDeletionBlocker[]> {
    const now = new Date();
    const [openShifts, openAttendance, pendingCheckouts, heldOrders, deductionJobs, projectionRows, approvals, nonzeroStock, draftRuns, unpaidHours] =
      await Promise.all([
        client.shift.count({ where: { branchId, status: 'active' } }),
        client.attendanceRecord.count({ where: { branchId, clockOutServerTime: null, deletedAt: null } }),
        client.checkoutAttempt.count({ where: { branchId, status: 'in_progress' } }),
        client.holdOrder.count({ where: { branchId, status: 'held', expiresAt: { gt: now } } }),
        client.inventoryDeductionJob.count({ where: { branchId, status: { in: ['pending', 'processing', 'failed'] } } }),
        client.inventoryProjectionOutbox.count({
          where: { status: { in: ['pending', 'processing', 'deferred', 'stuck'] }, movement: { branchId } },
        }),
        client.inventoryApprovalRequest.count({ where: { branchId, status: { in: ['PENDING', 'RETURNED'] } } }),
        client.inventoryStock.count({ where: { branchId, OR: [{ quantityOnHand: { not: 0 } }, { quantityReserved: { not: 0 } }] } }),
        client.payrollRun.count({ where: { branchId, status: 'draft' } }),
        branchesRepository.countUnpaidPayrollAttendance(branchId, client),
      ]);
    const blockers: BranchDeletionBlocker[] = [];
    const add = (code: BranchDeletionBlocker['code'], count: number, message: string) => {
      if (count > 0) blockers.push({ code, count, message });
    };
    add('open_shifts', openShifts, 'Close every open shift and count its cash.');
    add('open_attendance', openAttendance, 'Clock out everyone still clocked in, or correct their attendance.');
    add('pending_checkouts', pendingCheckouts, 'A sale is still being recorded or its result is uncertain. Finish or resolve it on the terminal.');
    add('held_orders', heldOrders, 'Complete or release every held order.');
    add(
      'pending_inventory_jobs',
      deductionJobs + projectionRows + approvals,
      'Stock updates are still pending, failed or awaiting approval. Let them finish, reconcile failed ones and review pending approvals.',
    );
    add('nonzero_stock', nonzeroStock, 'Some items still have stock on hand or reserved. Transfer it to another branch or record a count of zero.');
    add('draft_payroll_runs', draftRuns, 'Finalize or discard the draft payroll runs.');
    add('unpaid_payroll_hours', unpaidHours, 'Some worked hours are in no finalized payroll run. Finalize payroll for those dates first.');
    return blockers;
  },

  /**
   * Clocked-out attendance at this branch, from its first payroll policy on,
   * whose Manila date no finalized run covers (P66's rule, per branch).
   */
  async countUnpaidPayrollAttendance(branchId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<number> {
    const firstPolicy = await client.payrollPolicy.findFirst({ where: { branchId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    if (!firstPolicy) return 0;
    const [records, runs] = await Promise.all([
      client.attendanceRecord.findMany({
        where: { branchId, deletedAt: null, clockOutServerTime: { not: null }, clockInServerTime: { gte: firstPolicy.createdAt } },
        select: { clockInServerTime: true },
      }),
      client.payrollRun.findMany({ where: { branchId, status: 'finalized' }, select: { periodStart: true, periodEnd: true } }),
    ]);
    const isoDate = (value: Date) => value.toISOString().slice(0, 10);
    return records.filter((record) => {
      const day = manilaDateKey(record.clockInServerTime);
      return !runs.some((run) => isoDate(run.periodStart) <= day && day <= isoDate(run.periodEnd));
    }).length;
  },

  /**
   * Committed operational writes. Every stock change writes a stock
   * movement and every sale a transaction, so an unchanged fingerprint
   * across the delete shows no work committed between the checks and it.
   */
  async activityFingerprint(branchId: string, client: Prisma.TransactionClient): Promise<BranchActivityFingerprint> {
    const where = { branchId };
    const [sales, shifts, attendance, stockMovements, legacyMovements, expenses, extraSupplies, checkouts, approvals, payrollRuns] = await Promise.all([
      client.transaction.count({ where }),
      client.shift.count({ where }),
      client.attendanceRecord.count({ where }),
      client.inventoryStockMovement.count({ where }),
      client.inventoryMovement.count({ where }),
      client.expense.count({ where }),
      client.extraSupplyIssue.count({ where }),
      client.checkoutAttempt.count({ where }),
      client.inventoryApprovalRequest.count({ where }),
      client.payrollRun.count({ where }),
    ]);
    return { sales, shifts, attendance, stockMovements, legacyMovements, expenses, extraSupplies, checkouts, approvals, payrollRuns };
  },

  /**
   * POS-PERF-P67 — permanent deletion of the operational branch, in one transaction:
   * 1. A version-bound write takes the branch row lock (a concurrent edit or
   *    delete gives 'changed' / 'not_found').
   * 2. Blockers (open work, non-zero stock) are checked; any rolls back.
   * 3. The branch's own login accounts are deleted (P66 lifecycle: a marker
   *    ends their tokens, attribution stays on people). Its notifications and
   *    cached report snapshots go.
   * 4. The branches row is deleted. Configuration and access cascade; history
   *    references branch_records and is untouched. The delete waits for any
   *    write already holding the branch row (the live-branch trigger locks it
   *    FOR KEY SHARE); later writes fail.
   * 5. Blockers and the activity fingerprint are re-read; work that committed
   *    in between rolls everything back.
   */
  async deletePermanently(branchId: string, deletedBy: string, expectedVersion: Date): Promise<BranchDeletionOutcome> {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const locked = await tx.branch.updateMany({ where: { id: branchId, updatedAt: expectedVersion }, data: { updatedAt: expectedVersion } });
          if (locked.count === 0) {
            const exists = await tx.branch.findUnique({ where: { id: branchId }, select: { id: true } });
            return exists ? { outcome: 'changed' as const } : { outcome: 'not_found' as const };
          }
          const blockers = await branchesRepository.findDeletionBlockers(branchId, tx);
          if (blockers.length > 0) throw new BranchDeletionAbort({ outcome: 'blocked', blockers });
          const before = await branchesRepository.activityFingerprint(branchId, tx);
          const removed = await branchesRepository.countRemovedWithBranch(branchId, tx);

          const branchAccountIds = await branchesRepository.findBranchAccountIds(branchId, tx);
          if (branchAccountIds.length > 0) {
            const markerExpiry = new Date(Date.now() + REMOVED_ACCOUNT_MARKER_TTL_MS);
            for (const userId of branchAccountIds) {
              const tokenHash = removedAccountRevocationHash(userId);
              await tx.revokedToken.upsert({ where: { tokenHash }, create: { tokenHash, expiresAt: markerExpiry }, update: { expiresAt: markerExpiry } });
            }
            await tx.notification.deleteMany({ where: { recipientUserId: { in: branchAccountIds } } });
            await tx.expenseIdempotencyKey.deleteMany({ where: { userId: { in: branchAccountIds } } });
            await tx.person.updateMany({ where: { id: { in: branchAccountIds } }, data: { accountDeletedAt: new Date(), accountDeletedBy: deletedBy } });
            await tx.user.deleteMany({ where: { id: { in: branchAccountIds } } });
          }
          await tx.notification.deleteMany({ where: { branchId } });
          await tx.reportSnapshot.deleteMany({ where: { branchId } });
          await tx.branchRecord.update({ where: { id: branchId }, data: { deletedBy } });
          await tx.branch.delete({ where: { id: branchId } });

          const after = await branchesRepository.activityFingerprint(branchId, tx);
          if (Object.keys(before).some((key) => before[key] !== after[key])) throw new BranchDeletionAbort({ outcome: 'activity' });
          const lateBlockers = await branchesRepository.findDeletionBlockers(branchId, tx);
          if (lateBlockers.length > 0) throw new BranchDeletionAbort({ outcome: 'blocked', blockers: lateBlockers });
          return { outcome: 'deleted' as const, branchAccountIds, removed };
        },
        // Many counts share one pooled connection; leave room on a remote pooler.
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof BranchDeletionAbort) return error.result;
      throw error;
    }
  },
};

/** Rolls the deletion transaction back with a reportable outcome. */
class BranchDeletionAbort extends Error {
  constructor(readonly result: BranchDeletionOutcome) {
    super('branch deletion rolled back');
  }
}
