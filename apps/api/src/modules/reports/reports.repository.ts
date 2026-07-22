import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type {
  ReportFilters,
  ReportType,
  DailySalesReportRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  ProductPerformanceReportRow,
  FlavorPerformanceReportRow,
  EmployeePerformanceReportRow,
  InventoryValuationReportRow,
  BranchComparisonReportRow,
  InventoryAnalyticsReport,
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

  async getProductPerformance(filters: ReportFilters): Promise<ProductPerformanceReportRow[]> {
    const range = dateRangeFilter(filters);
    const completedTransactionIds = await prisma.transaction
      .findMany({
        where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));
    if (completedTransactionIds.length === 0) return [];

    const grouped = await prisma.transactionItem.groupBy({
      by: ['productVariantId'],
      where: { transactionId: { in: completedTransactionIds } },
      _sum: { quantity: true, lineTotal: true },
      _count: { id: true },
    });
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: grouped.map((g) => g.productVariantId) } },
      include: { product: { select: { name: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    return grouped
      .map((g) => {
        const variant = variantById.get(g.productVariantId);
        return {
          product_variant_id: g.productVariantId,
          product_name: variant?.product.name ?? 'Unknown Product',
          variant_name: variant?.name ?? 'Unknown Variant',
          units_sold: g._sum.quantity ?? 0,
          gross_revenue: g._sum.lineTotal?.toNumber() ?? 0,
          transaction_count: g._count.id,
        };
      })
      .sort((a, b) => b.gross_revenue - a.gross_revenue);
  },

  async getFlavorPerformance(filters: ReportFilters): Promise<FlavorPerformanceReportRow[]> {
    const range = dateRangeFilter(filters);
    const completedTransactionIds = await prisma.transaction
      .findMany({
        where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));
    if (completedTransactionIds.length === 0) return [];

    const grouped = await prisma.transactionItem.groupBy({
      by: ['flavorId'],
      where: { transactionId: { in: completedTransactionIds }, flavorId: { not: null } },
      _sum: { quantity: true, lineTotal: true },
    });
    const flavorIds = grouped.map((g) => g.flavorId).filter((id): id is string => id !== null);
    const flavors = await prisma.flavor.findMany({ where: { id: { in: flavorIds } }, select: { id: true, name: true } });
    const flavorNameById = new Map(flavors.map((f) => [f.id, f.name]));

    return grouped
      .filter((g): g is typeof g & { flavorId: string } => g.flavorId !== null)
      .map((g) => ({
        flavor_id: g.flavorId,
        flavor_name: flavorNameById.get(g.flavorId) ?? 'Unknown Flavor',
        units_sold: g._sum.quantity ?? 0,
        gross_revenue: g._sum.lineTotal?.toNumber() ?? 0,
      }))
      .sort((a, b) => b.gross_revenue - a.gross_revenue);
  },

  async getEmployeePerformance(filters: ReportFilters): Promise<EmployeePerformanceReportRow[]> {
    const range = dateRangeFilter(filters);
    const salesGrouped = await prisma.transaction.groupBy({
      by: ['cashierId', 'branchId'],
      where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    if (salesGrouped.length === 0) return [];

    const employeeIds = [...new Set(salesGrouped.map((g) => g.cashierId))];
    const [employees, attendanceRecords, branches] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
      prisma.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, deletedAt: null, ...(range && { clockInServerTime: range }) },
        select: { employeeId: true, actualWorkMinutes: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const employeeById = new Map(employees.map((e) => [e.id, e]));
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    const minutesByEmployee = new Map<string, number>();
    for (const record of attendanceRecords) {
      minutesByEmployee.set(record.employeeId, (minutesByEmployee.get(record.employeeId) ?? 0) + (record.actualWorkMinutes ?? 0));
    }

    return salesGrouped
      .map((g) => {
        const employee = employeeById.get(g.cashierId);
        return {
          employee_id: g.cashierId,
          employee_name: employee ? `${employee.firstName} ${employee.lastName}` : 'Unknown Employee',
          branch_id: g.branchId,
          branch_name: branchNameById.get(g.branchId) ?? 'Unknown Branch',
          transaction_count: g._count._all,
          gross_sales: g._sum.totalAmount?.toNumber() ?? 0,
          hours_worked: Math.round(((minutesByEmployee.get(g.cashierId) ?? 0) / 60) * 100) / 100,
        };
      })
      .sort((a, b) => b.gross_sales - a.gross_sales);
  },

  async getInventoryValuation(filters: ReportFilters): Promise<InventoryValuationReportRow[]> {
    const ingredients = await prisma.ingredient.findMany({
      where: { deletedAt: null, ...(filters.branchId && { branchId: filters.branchId }) },
      select: { id: true, name: true, branchId: true, unit: true, unitCost: true, lowStockThreshold: true, criticalThreshold: true },
    });
    if (ingredients.length === 0) return [];

    const movementSums = await prisma.inventoryMovement.groupBy({
      by: ['ingredientId'],
      where: { ingredientId: { in: ingredients.map((i) => i.id) } },
      _sum: { quantityChange: true },
    });
    const stockById = new Map(movementSums.map((m) => [m.ingredientId, m._sum.quantityChange?.toNumber() ?? 0]));

    return ingredients
      .map((ingredient) => {
        const currentStock = stockById.get(ingredient.id) ?? 0;
        const unitCost = ingredient.unitCost?.toNumber() ?? null;
        const status =
          currentStock <= ingredient.criticalThreshold.toNumber() ? 'critical' : currentStock <= ingredient.lowStockThreshold.toNumber() ? 'low' : 'ok';
        return {
          ingredient_id: ingredient.id,
          ingredient_name: ingredient.name,
          branch_id: ingredient.branchId,
          unit: ingredient.unit,
          current_stock: currentStock,
          unit_cost: unitCost,
          total_value: unitCost !== null ? Math.round(currentStock * unitCost * 100) / 100 : 0,
          status: status as 'ok' | 'low' | 'critical',
        };
      })
      .sort((a, b) => b.total_value - a.total_value);
  },

  async getBranchComparison(filters: ReportFilters): Promise<BranchComparisonReportRow[]> {
    const range = dateRangeFilter(filters);
    const [salesGrouped, activeShifts, ingredients, branches] = await Promise.all([
      prisma.transaction.groupBy({ by: ['branchId'], where: { status: 'completed', ...(range && { createdAt: range }) }, _sum: { totalAmount: true }, _count: { _all: true } }),
      prisma.shift.findMany({ where: { status: 'active' }, select: { branchId: true } }),
      prisma.ingredient.findMany({ where: { deletedAt: null }, select: { id: true, branchId: true, lowStockThreshold: true } }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);

    const activeShiftCountByBranch = new Map<string, number>();
    for (const shift of activeShifts) activeShiftCountByBranch.set(shift.branchId, (activeShiftCountByBranch.get(shift.branchId) ?? 0) + 1);

    const movementSums = ingredients.length
      ? await prisma.inventoryMovement.groupBy({ by: ['ingredientId'], where: { ingredientId: { in: ingredients.map((i) => i.id) } }, _sum: { quantityChange: true } })
      : [];
    const stockById = new Map(movementSums.map((m) => [m.ingredientId, m._sum.quantityChange?.toNumber() ?? 0]));
    const lowStockCountByBranch = new Map<string, number>();
    for (const ingredient of ingredients) {
      const stock = stockById.get(ingredient.id) ?? 0;
      if (stock <= ingredient.lowStockThreshold.toNumber()) lowStockCountByBranch.set(ingredient.branchId, (lowStockCountByBranch.get(ingredient.branchId) ?? 0) + 1);
    }

    const salesByBranch = new Map(salesGrouped.map((g) => [g.branchId, g]));
    return branches
      .map((branch) => {
        const sales = salesByBranch.get(branch.id);
        return {
          branch_id: branch.id,
          branch_name: branch.name,
          gross_sales: sales?._sum.totalAmount?.toNumber() ?? 0,
          transaction_count: sales?._count._all ?? 0,
          active_shift_count: activeShiftCountByBranch.get(branch.id) ?? 0,
          low_stock_ingredient_count: lowStockCountByBranch.get(branch.id) ?? 0,
        };
      })
      .sort((a, b) => b.gross_sales - a.gross_sales);
  },

  async getInventoryAnalytics(params: { branchId?: string; dateFrom: Date; dateTo: Date; periodDays: number }): Promise<InventoryAnalyticsReport> {
    const REORDER_LOOKBACK_DAYS = 30;
    const REORDER_COVERAGE_DAYS = 14;
    const REORDER_THRESHOLD_MULTIPLIER = 1.5;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const { branchId, dateFrom, dateTo, periodDays } = params;
    const branchWhere = branchId ? { branchId } : {};
    const reorderLookbackFrom = new Date(dateTo.getTime() - REORDER_LOOKBACK_DAYS * MS_PER_DAY);

    const [consumptionGrouped, wasteMovements, lastMovementByIngredient, reorderConsumptionGrouped, ingredients, branches, totalMovements] = await Promise.all([
      prisma.inventoryMovement.groupBy({
        by: ['ingredientId'],
        where: { movementType: 'sale_deduction', createdAt: { gte: dateFrom, lte: dateTo }, ...branchWhere },
        _sum: { quantityChange: true },
      }),
      prisma.inventoryMovement.findMany({
        where: { movementType: 'waste', createdAt: { gte: dateFrom, lte: dateTo }, ...branchWhere },
        select: { quantityChange: true, createdAt: true, ingredientId: true },
      }),
      prisma.inventoryMovement.groupBy({ by: ['ingredientId'], where: { ...branchWhere }, _max: { createdAt: true } }),
      prisma.inventoryMovement.groupBy({
        by: ['ingredientId'],
        where: { movementType: 'sale_deduction', createdAt: { gte: reorderLookbackFrom, lte: dateTo }, ...branchWhere },
        _sum: { quantityChange: true },
      }),
      prisma.ingredient.findMany({
        where: { deletedAt: null, ...branchWhere },
        select: { id: true, name: true, unit: true, currentStock: true, lowStockThreshold: true, unitCost: true, branchId: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
      prisma.inventoryMovement.count({ where: { createdAt: { gte: dateFrom, lte: dateTo }, ...branchWhere } }),
    ]);

    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    const lastMovementById = new Map(lastMovementByIngredient.map((m) => [m.ingredientId, m._max.createdAt]));

    const consumption = consumptionGrouped
      .map((g) => ({ ingredient: ingredientById.get(g.ingredientId), totalConsumed: Math.abs(g._sum.quantityChange?.toNumber() ?? 0) }))
      .filter((c): c is { ingredient: NonNullable<typeof c.ingredient>; totalConsumed: number } => c.ingredient !== undefined);

    const fastMovers = [...consumption]
      .sort((a, b) => b.totalConsumed - a.totalConsumed)
      .slice(0, 10)
      .map((c) => ({
        ingredient_id: c.ingredient.id,
        name: c.ingredient.name,
        unit: c.ingredient.unit,
        total_consumed: c.totalConsumed,
        avg_daily_consumption: Math.round((c.totalConsumed / periodDays) * 1000) / 1000,
      }));

    const slowMovers = [...consumption]
      .sort((a, b) => a.totalConsumed - b.totalConsumed)
      .slice(0, 10)
      .map((c) => {
        const lastMovement = lastMovementById.get(c.ingredient.id) ?? null;
        return {
          ingredient_id: c.ingredient.id,
          name: c.ingredient.name,
          unit: c.ingredient.unit,
          total_consumed: c.totalConsumed,
          days_since_last_movement: lastMovement ? Math.floor((dateTo.getTime() - lastMovement.getTime()) / MS_PER_DAY) : null,
        };
      });

    const wasteByDay = new Map<string, { quantity: number; cost: number }>();
    for (const w of wasteMovements) {
      const day = w.createdAt.toISOString().slice(0, 10);
      const qty = Math.abs(w.quantityChange.toNumber());
      const unitCost = ingredientById.get(w.ingredientId)?.unitCost?.toNumber() ?? 0;
      const existing = wasteByDay.get(day) ?? { quantity: 0, cost: 0 };
      existing.quantity += qty;
      existing.cost += qty * unitCost;
      wasteByDay.set(day, existing);
    }
    const wasteTrends = [...wasteByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, total_waste_quantity: Math.round(v.quantity * 1000) / 1000, total_waste_cost: Math.round(v.cost * 100) / 100 }));

    // Turnover is a cost ratio (consumption cost ÷ inventory value), so
    // per-branch consumption here is priced, not raw quantity — mixing
    // units (kg, pieces, L) across ingredients only works once costed.
    const consumedCostByBranch = new Map<string, number>();
    for (const c of consumption) {
      const unitCost = c.ingredient.unitCost?.toNumber() ?? 0;
      consumedCostByBranch.set(c.ingredient.branchId, (consumedCostByBranch.get(c.ingredient.branchId) ?? 0) + c.totalConsumed * unitCost);
    }
    const inventoryValueByBranch = new Map<string, number>();
    for (const ingredient of ingredients) {
      const unitCost = ingredient.unitCost?.toNumber() ?? 0;
      inventoryValueByBranch.set(ingredient.branchId, (inventoryValueByBranch.get(ingredient.branchId) ?? 0) + ingredient.currentStock.toNumber() * unitCost);
    }
    const branchIdsWithData = branchId ? [branchId] : [...new Set(ingredients.map((i) => i.branchId))];
    const turnoverByBranch = branchIdsWithData.map((id) => {
      const consumedCost = consumedCostByBranch.get(id) ?? 0;
      const avgInventoryValue = inventoryValueByBranch.get(id) ?? 0;
      return {
        branch_id: id,
        branch_name: branchNameById.get(id) ?? 'Unknown Branch',
        turnover_rate: avgInventoryValue > 0 ? Math.round((consumedCost / avgInventoryValue) * 1000) / 1000 : 0,
        total_consumed: Math.round(consumedCost * 100) / 100,
        avg_inventory_value: Math.round(avgInventoryValue * 100) / 100,
      };
    });

    const reorderConsumedByIngredient = new Map(reorderConsumptionGrouped.map((g) => [g.ingredientId, Math.abs(g._sum.quantityChange?.toNumber() ?? 0)]));
    const reorderRecommendations = ingredients
      .filter((i) => i.currentStock.toNumber() <= i.lowStockThreshold.toNumber() * REORDER_THRESHOLD_MULTIPLIER)
      .map((i) => {
        const currentStock = i.currentStock.toNumber();
        const avgDailyConsumption = (reorderConsumedByIngredient.get(i.id) ?? 0) / REORDER_LOOKBACK_DAYS;
        const daysUntilStockout = avgDailyConsumption > 0 ? Math.round((currentStock / avgDailyConsumption) * 10) / 10 : null;
        return {
          ingredient_id: i.id,
          name: i.name,
          current_stock: currentStock,
          avg_daily_consumption: Math.round(avgDailyConsumption * 1000) / 1000,
          days_until_stockout: daysUntilStockout,
          recommended_reorder_qty: Math.round(avgDailyConsumption * REORDER_COVERAGE_DAYS * 1000) / 1000,
        };
      })
      .sort((a, b) => (a.days_until_stockout ?? Infinity) - (b.days_until_stockout ?? Infinity));

    const totalWasteCost = wasteTrends.reduce((sum, w) => sum + w.total_waste_cost, 0);
    const totalConsumptionCost = consumption.reduce((sum, c) => sum + c.totalConsumed * (c.ingredient.unitCost?.toNumber() ?? 0), 0);
    const avgTurnoverRate = turnoverByBranch.length ? turnoverByBranch.reduce((sum, t) => sum + t.turnover_rate, 0) / turnoverByBranch.length : 0;

    return {
      fast_movers: fastMovers,
      slow_movers: slowMovers,
      waste_trends: wasteTrends,
      turnover_by_branch: turnoverByBranch,
      reorder_recommendations: reorderRecommendations,
      summary: {
        total_movements: totalMovements,
        total_waste_cost: Math.round(totalWasteCost * 100) / 100,
        total_consumption_cost: Math.round(totalConsumptionCost * 100) / 100,
        avg_turnover_rate: Math.round(avgTurnoverRate * 1000) / 1000,
      },
    };
  },

  async saveSnapshot(reportType: ReportType, branchId: string | null, data: unknown, parameters: unknown): Promise<void> {
    const created = await prisma.reportSnapshot.create({
      data: { reportType, branchId, payload: data as Prisma.InputJsonValue, parameters: parameters as Prisma.InputJsonValue },
    });
    // Keep only the latest snapshot per (reportType, branchId) — refreshes
    // happen every 15 min under stale-while-revalidate, so without this the
    // table grows without bound.
    await prisma.reportSnapshot.deleteMany({ where: { reportType, branchId, id: { not: created.id } } });
  },

  async getLatestSnapshot(reportType: ReportType, branchId: string | null) {
    return prisma.reportSnapshot.findFirst({ where: { reportType, branchId }, orderBy: { computedAt: 'desc' } });
  },

  async countRows(reportType: ReportType, filters: ReportFilters): Promise<number> {
    const range = dateRangeFilter(filters);
    switch (reportType) {
      case 'VOID_REFUND':
        return prisma.transaction.count({ where: { status: { in: ['voided', 'refunded'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'INVENTORY_MOVEMENT':
        return prisma.inventoryMovement.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'ATTENDANCE_SUMMARY':
        return prisma.attendanceRecord.count({ where: { deletedAt: null, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { clockInServerTime: range }) } });
      case 'FRAUD_ALERT_SUMMARY':
        return prisma.fraudAlert.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'SHIFT_SUMMARY':
        return prisma.shift.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { startedAt: range }) } });
      case 'CASH_RECONCILIATION':
        return prisma.shift.count({ where: { status: { in: ['closed', 'flagged'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { startedAt: range }) } });
      case 'DAILY_SALES':
        return this.getDailySales(filters).then((rows) => rows.length);
      case 'DISCOUNT_COMPLIANCE':
        return this.getDiscountCompliance(filters).then((rows) => rows.length);
      case 'PRODUCT_PERFORMANCE':
        return this.getProductPerformance(filters).then((rows) => rows.length);
      case 'FLAVOR_PERFORMANCE':
        return this.getFlavorPerformance(filters).then((rows) => rows.length);
      case 'EMPLOYEE_PERFORMANCE':
        return this.getEmployeePerformance(filters).then((rows) => rows.length);
      case 'INVENTORY_VALUATION':
        return this.getInventoryValuation(filters).then((rows) => rows.length);
      case 'BRANCH_COMPARISON':
        return this.getBranchComparison(filters).then((rows) => rows.length);
      case 'AUDIT_LOG':
        return this.getAuditLog(filters).then((rows) => rows.length);
      default:
        return 0;
    }
  },

  async getAuditLog(filters: ReportFilters) {
    const range = dateRangeFilter(filters);
    const rows = await prisma.auditLog.findMany({
      where: {
        action: { in: ['LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGOUT', 'LOGOUT_ALL_DEVICES', 'PIN_LOGIN_SUCCESS', 'ACCOUNT_UNLOCKED'] },
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
        ...(range ? { createdAt: range } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        action: true,
        actorId: true,
        actorRole: true,
        ipAddress: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    return rows.map((r) => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      action: r.action,
      actor_id: r.actorId,
      actor_role: r.actorRole,
      ip_address: r.ipAddress,
    }));
  },
};
