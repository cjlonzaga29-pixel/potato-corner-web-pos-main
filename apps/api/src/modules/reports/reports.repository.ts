import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type {
  ReportFilters,
  DailySalesReportRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
} from './reports.types.js';

/**
 * Reports repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
function dateRangeFilter(filters: ReportFilters): { gte?: Date; lte?: Date } | undefined {
  if (!filters.dateFrom && !filters.dateTo) return undefined;
  return {
    ...(filters.dateFrom && { gte: filters.dateFrom }),
    ...(filters.dateTo && { lte: filters.dateTo }),
  };
}

export const reportsRepository = {
  async getDailySales(filters: ReportFilters): Promise<DailySalesReportRow[]> {
    const createdAt = dateRangeFilter(filters);
    const where: Prisma.TransactionWhereInput = {
      ...(filters.branchId && { branchId: filters.branchId }),
      ...(createdAt && { createdAt }),
    };
    const [rows, branches] = await Promise.all([
      prisma.transaction.findMany({
        where,
        select: { branchId: true, status: true, totalAmount: true, discountAmount: true, vatAmount: true, createdAt: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

    const buckets = new Map<string, DailySalesReportRow>();
    for (const row of rows) {
      const reportDate = row.createdAt.toISOString().slice(0, 10);
      const key = `${reportDate}_${row.branchId}`;
      const existing = buckets.get(key) ?? {
        report_date: reportDate,
        branch_id: row.branchId,
        branch_name: branchNameById.get(row.branchId) ?? 'Unknown Branch',
        gross_sales: 0,
        discount_total: 0,
        vat_total: 0,
        net_sales: 0,
        completed_count: 0,
        voided_count: 0,
        refunded_count: 0,
      };
      if (row.status === 'completed') {
        existing.gross_sales += row.totalAmount.toNumber();
        existing.discount_total += row.discountAmount.toNumber();
        existing.vat_total += row.vatAmount.toNumber();
        existing.net_sales += row.totalAmount.toNumber() - row.vatAmount.toNumber();
        existing.completed_count += 1;
      } else if (row.status === 'voided') {
        existing.voided_count += 1;
      } else if (row.status === 'refunded') {
        existing.refunded_count += 1;
      }
      buckets.set(key, existing);
    }
    return [...buckets.values()].sort(
      (a, b) => a.report_date.localeCompare(b.report_date) || a.branch_name.localeCompare(b.branch_name),
    );
  },

  async getShiftSummary(filters: ReportFilters): Promise<ShiftSummaryReportRow[]> {
    const startedAt = dateRangeFilter(filters);
    const shifts = await prisma.shift.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(startedAt && { startedAt }) },
      include: { branch: { select: { name: true } }, cashier: { select: { firstName: true, lastName: true } } },
      orderBy: { startedAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return shifts.map((shift) => ({
      shift_id: shift.id,
      branch_id: shift.branchId,
      branch_name: shift.branch.name,
      cashier_id: shift.cashierId,
      cashier_name: `${shift.cashier.firstName} ${shift.cashier.lastName}`,
      status: shift.status,
      started_at: shift.startedAt.toISOString(),
      closed_at: shift.closedAt ? shift.closedAt.toISOString() : null,
      opening_cash_amount: shift.openingCashAmount.toNumber(),
      closing_cash_amount: shift.closingCashAmount ? shift.closingCashAmount.toNumber() : null,
      expected_closing_cash: shift.expectedClosingCash ? shift.expectedClosingCash.toNumber() : null,
      cash_variance: shift.cashVariance ? shift.cashVariance.toNumber() : null,
      variance_approved: shift.varianceApproved,
      cash_sales_total: shift.cashSalesTotal.toNumber(),
      gcash_sales_total: shift.gcashSalesTotal.toNumber(),
      total_transaction_count: shift.totalTransactionCount,
      voided_count: shift.voidedCount,
      refunded_count: shift.refundedCount,
      total_discount_amount: shift.totalDiscountAmount.toNumber(),
      pwd_sc_transaction_count: shift.pwdScTransactionCount,
    }));
  },

  async getCashReconciliation(filters: ReportFilters): Promise<CashReconciliationReportRow[]> {
    const startedAt = dateRangeFilter(filters);
    const shifts = await prisma.shift.findMany({
      where: { status: { in: ['closed', 'flagged'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(startedAt && { startedAt }) },
      include: { branch: { select: { name: true } }, cashier: { select: { firstName: true, lastName: true } }, denominations: true },
      orderBy: { startedAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return shifts.map((shift) => {
      const openingCountedTotal = shift.denominations
        .filter((d) => d.countType === 'opening')
        .reduce((sum, d) => sum + d.totalValue.toNumber(), 0);
      const closingCountedTotal = shift.denominations
        .filter((d) => d.countType === 'closing')
        .reduce((sum, d) => sum + d.totalValue.toNumber(), 0);
      return {
        shift_id: shift.id,
        branch_id: shift.branchId,
        branch_name: shift.branch.name,
        cashier_name: `${shift.cashier.firstName} ${shift.cashier.lastName}`,
        status: shift.status,
        opening_counted_total: openingCountedTotal,
        closing_counted_total: shift.denominations.some((d) => d.countType === 'closing') ? closingCountedTotal : null,
        expected_closing_cash: shift.expectedClosingCash ? shift.expectedClosingCash.toNumber() : null,
        cash_variance: shift.cashVariance ? shift.cashVariance.toNumber() : null,
        variance_approved: shift.varianceApproved,
        variance_explanation: shift.varianceExplanation,
      };
    });
  },

  async getVoidRefund(filters: ReportFilters): Promise<VoidRefundReportRow[]> {
    const range = dateRangeFilter(filters);
    const transactions = await prisma.transaction.findMany({
      where: { status: { in: ['voided', 'refunded'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: {
        branch: { select: { name: true } },
        cashier: { select: { firstName: true, lastName: true } },
        voidedBy: { select: { firstName: true, lastName: true } },
        refundedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return transactions.map((tx) => {
      const isVoided = tx.status === 'voided';
      const actionedBy = isVoided ? tx.voidedBy : tx.refundedBy;
      return {
        transaction_id: tx.id,
        transaction_number: tx.transactionNumber,
        branch_id: tx.branchId,
        branch_name: tx.branch.name,
        cashier_name: `${tx.cashier.firstName} ${tx.cashier.lastName}`,
        status: tx.status as 'voided' | 'refunded',
        total_amount: tx.totalAmount.toNumber(),
        reason: isVoided ? tx.voidReason : tx.refundReason,
        actioned_by_name: actionedBy ? `${actionedBy.firstName} ${actionedBy.lastName}` : null,
        actioned_at: (isVoided ? tx.voidedAt : tx.refundedAt)?.toISOString() ?? null,
      };
    });
  },

  async getDiscountCompliance(filters: ReportFilters): Promise<DiscountComplianceReportRow[]> {
    const range = dateRangeFilter(filters);
    const [rows, branches] = await Promise.all([
      prisma.transaction.groupBy({
        by: ['branchId', 'discountType'],
        where: { discountType: { not: null }, status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        _count: { _all: true },
        _sum: { discountAmount: true, vatExemptAmount: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    return rows
      .filter((row): row is typeof row & { discountType: string } => row.discountType !== null)
      .map((row) => ({
        branch_id: row.branchId,
        branch_name: branchNameById.get(row.branchId) ?? 'Unknown Branch',
        discount_type: row.discountType,
        transaction_count: row._count._all,
        total_discount_amount: row._sum.discountAmount?.toNumber() ?? 0,
        total_vat_exempt_amount: row._sum.vatExemptAmount?.toNumber() ?? 0,
      }));
  },

  async getInventoryMovement(filters: ReportFilters): Promise<InventoryMovementReportRow[]> {
    const range = dateRangeFilter(filters);
    const movements = await prisma.inventoryMovement.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: { branch: { select: { name: true } }, ingredient: { select: { name: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    const recorderIds = [...new Set(movements.map((m) => m.recordedBy).filter((id): id is string => id !== null))];
    const recorders = recorderIds.length
      ? await prisma.user.findMany({ where: { id: { in: recorderIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const recorderNameById = new Map(recorders.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    return movements.map((m) => ({
      movement_id: m.id,
      branch_id: m.branchId,
      branch_name: m.branch.name,
      ingredient_id: m.ingredientId,
      ingredient_name: m.ingredient.name,
      unit: m.ingredient.unit,
      movement_type: m.movementType,
      quantity_change: m.quantityChange.toNumber(),
      quantity_before: m.quantityBefore.toNumber(),
      quantity_after: m.quantityAfter.toNumber(),
      recorded_by_name: m.recordedBy ? (recorderNameById.get(m.recordedBy) ?? null) : null,
      created_at: m.createdAt.toISOString(),
    }));
  },

  async getAttendanceSummary(filters: ReportFilters): Promise<AttendanceSummaryReportRow[]> {
    const range = dateRangeFilter(filters);
    const records = await prisma.attendanceRecord.findMany({
      where: { deletedAt: null, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { clockInServerTime: range }) },
      include: { employee: { select: { firstName: true, lastName: true } }, branch: { select: { name: true } } },
      orderBy: { clockInServerTime: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return records.map((r) => ({
      employee_id: r.employeeId,
      employee_name: `${r.employee.firstName} ${r.employee.lastName}`,
      branch_id: r.branchId,
      branch_name: r.branch.name,
      clock_in: r.clockInServerTime.toISOString(),
      clock_out: r.clockOutServerTime ? r.clockOutServerTime.toISOString() : null,
      actual_work_minutes: r.actualWorkMinutes,
      overtime_minutes: r.overtimeMinutes,
      break_minutes: r.breakMinutes,
      status: r.status,
    }));
  },

  async getFraudAlertSummary(filters: ReportFilters): Promise<FraudAlertSummaryReportRow[]> {
    const range = dateRangeFilter(filters);
    const alerts = await prisma.fraudAlert.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: { branch: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return alerts.map((a) => ({
      alert_id: a.id,
      alert_type: a.alertType,
      severity: a.severity,
      employee_id: a.employeeId,
      branch_id: a.branchId,
      branch_name: a.branch?.name ?? null,
      status: a.status,
      created_at: a.createdAt.toISOString(),
      updated_at: a.updatedAt.toISOString(),
    }));
  },
};
