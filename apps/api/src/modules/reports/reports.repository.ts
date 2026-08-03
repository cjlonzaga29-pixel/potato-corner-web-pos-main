import type { Prisma, $Enums } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { manilaDateKey, dayBounds, monthBounds } from '../../lib/manila-time.js';
import { classifyStockStatus } from '../universal-inventory/universal-inventory.service.js';
import { convertQuantity, UnitConversionError } from '../product-components/unit-conversion.util.js';
import { computeFinancialMetrics } from '../../lib/financial-metrics.js';
import type {
  ReportFilters,
  ReportType,
  DailySalesReportRow,
  DailySalesTransactionRow,
  ShiftSummaryReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  PaymentMethodMixReportRow,
  InventoryMovementReportRow,
  InventoryConsumptionSummaryReportRow,
  InventorySummaryReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  ProductPerformanceReportRow,
  FlavorPerformanceReportRow,
  EmployeePerformanceReportRow,
  InventoryValuationReportRow,
  AdminInventoryValuationRollupResponse,
  BranchComparisonReportRow,
  InventoryAnalyticsReport,
} from './reports.types.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

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

type VoidRefundTransaction = Prisma.TransactionGetPayload<{
  include: {
    branch: { select: { name: true } };
    cashier: { select: { firstName: true; lastName: true } };
    voidedBy: { select: { firstName: true; lastName: true } };
    refundedBy: { select: { firstName: true; lastName: true } };
  };
}>;

function mapVoidRefundRow(tx: VoidRefundTransaction): VoidRefundReportRow {
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
        select: { branchId: true, status: true, subtotal: true, totalAmount: true, discountAmount: true, vatAmount: true, createdAt: true },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

    interface Bucket {
      reportDate: string;
      branchId: string;
      branchName: string;
      grossSales: number;
      discountTotal: number;
      vatTotal: number;
      refundTotal: number;
      completedCount: number;
      voidedCount: number;
      refundedCount: number;
    }
    const buckets = new Map<string, Bucket>();
    for (const row of rows) {
      const reportDate = manilaDateKey(row.createdAt);
      const key = `${reportDate}_${row.branchId}`;
      const existing = buckets.get(key) ?? {
        reportDate,
        branchId: row.branchId,
        branchName: branchNameById.get(row.branchId) ?? 'Unknown Branch',
        grossSales: 0,
        discountTotal: 0,
        vatTotal: 0,
        refundTotal: 0,
        completedCount: 0,
        voidedCount: 0,
        refundedCount: 0,
      };
      if (row.status === 'completed') {
        // gross_sales is the pre-discount line-item total (Transaction.subtotal),
        // matching lib/financial-metrics.ts's canonical grossSales definition —
        // Transaction.totalAmount is post-discount and would silently understate
        // gross sales for any discounted transaction (PWD/Senior, promos, etc.).
        existing.grossSales += row.subtotal.toNumber();
        existing.discountTotal += row.discountAmount.toNumber();
        existing.vatTotal += row.vatAmount.toNumber();
        existing.completedCount += 1;
      } else if (row.status === 'voided') {
        existing.voidedCount += 1;
      } else if (row.status === 'refunded') {
        // net_sales below (via computeFinancialMetrics) must subtract this,
        // the same way branchStats' todayNetSales does — otherwise a
        // refunded sale's revenue would silently stay counted as net,
        // diverging from the dashboard's figure for the same branch/day.
        existing.refundTotal += row.totalAmount.toNumber();
        existing.refundedCount += 1;
      }
      buckets.set(key, existing);
    }
    return [...buckets.values()]
      .map((b) => {
        // computeFinancialMetrics is the one formula every dashboard/report
        // reads from — reusing it here (rather than re-deriving net_sales as
        // totalAmount - vatAmount) keeps this report's net_sales identical to
        // the dashboard's todayNetSales/monthly-sum for the same branch/range,
        // per the "zero calculation differences" reconciliation requirement.
        const metrics = computeFinancialMetrics({
          grossSales: b.grossSales,
          discountTotal: b.discountTotal,
          refundTotal: b.refundTotal,
          cogs: 0,
          expenseTotal: 0,
        });
        return {
          report_date: b.reportDate,
          branch_id: b.branchId,
          branch_name: b.branchName,
          gross_sales: metrics.grossSales,
          discount_total: metrics.discountTotal,
          vat_total: round2(b.vatTotal),
          net_sales: metrics.netSales,
          completed_count: b.completedCount,
          voided_count: b.voidedCount,
          refunded_count: b.refundedCount,
        };
      })
      .sort((a, b) => a.report_date.localeCompare(b.report_date) || a.branch_name.localeCompare(b.branch_name));
  },

  /**
   * One row per completed transaction, same where-clause shape as
   * transactions.repository.ts's buildListWhere with status: 'completed' —
   * matches exactly what the Supervisor/Branch Reports page's Daily Sales
   * tab renders (see reports.types.ts's DailySalesTransactionRow doc
   * comment). Used only by DAILY_SALES's PDF export for that tab.
   */
  async getDailySalesTransactions(filters: ReportFilters): Promise<DailySalesTransactionRow[]> {
    const createdAt = dateRangeFilter(filters);
    const rows = await prisma.transaction.findMany({
      where: {
        status: 'completed',
        ...(filters.branchId && { branchId: filters.branchId }),
        ...(createdAt && { createdAt }),
      },
      select: {
        transactionNumber: true,
        paymentMethod: true,
        totalAmount: true,
        vatAmount: true,
        discountAmount: true,
        discountType: true,
        createdAt: true,
        cashier: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit,
    });
    return rows.map((row) => ({
      receipt_number: row.transactionNumber,
      payment_method: row.paymentMethod,
      total_amount: row.totalAmount.toNumber(),
      vat_amount: row.vatAmount.toNumber(),
      discount_amount: row.discountAmount.toNumber(),
      discount_type: row.discountType,
      created_at: row.createdAt.toISOString(),
      cashier_name: `${row.cashier.firstName} ${row.cashier.lastName}`,
    }));
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
    return transactions.map(mapVoidRefundRow);
  },

  // PDF-export-only counterpart to getVoidRefund, used exclusively by
  // reports.service.ts's VOID_REFUND PDF branch. The Supervisor/Branch
  // Reports page's Void/Refund tab (branch-ops/reports-view.tsx) does NOT
  // render getVoidRefund's combined, interleaved-by-date rows — it composes
  // its table from two independent status-filtered transaction queries
  // (voided, then refunded), each capped at the page's own limit. Mirrors
  // that exact composition (two separate queries, voided rows first, each
  // ordered desc by createdAt and capped at filters.limit) so the exported
  // PDF's rows, order, and row count match what the screen and its KPI
  // totals (Total Voided/Refunded, Voided/Refunded Amount) actually show.
  async getVoidRefundForExport(filters: ReportFilters): Promise<VoidRefundReportRow[]> {
    const range = dateRangeFilter(filters);
    const include = {
      branch: { select: { name: true } },
      cashier: { select: { firstName: true, lastName: true } },
      voidedBy: { select: { firstName: true, lastName: true } },
      refundedBy: { select: { firstName: true, lastName: true } },
    } as const;
    const [voided, refunded] = await Promise.all([
      prisma.transaction.findMany({
        where: { status: 'voided', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        include,
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
      }),
      prisma.transaction.findMany({
        where: { status: 'refunded', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
        include,
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
      }),
    ]);
    return [...voided.map(mapVoidRefundRow), ...refunded.map(mapVoidRefundRow)];
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

  async getPaymentMethodMix(filters: ReportFilters): Promise<PaymentMethodMixReportRow[]> {
    const range = dateRangeFilter(filters);
    const rows = await prisma.transaction.groupBy({
      by: ['paymentMethod'],
      where: { status: 'completed', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      _count: { _all: true },
      _sum: { totalAmount: true },
    });
    return rows.map((row) => ({
      payment_method: row.paymentMethod,
      transaction_count: row._count._all,
      total_amount: row._sum.totalAmount?.toNumber() ?? 0,
    }));
  },

  // Final reporting cutover (CR-007 §20): sourced from InventoryStockMovement/
  // InventoryItem only — never InventoryMovement or Ingredient. Field names
  // (ingredient_id, ingredient_name, ...) are kept for API/CSV/PDF compatibility
  // even though the source is now InventoryItem, not Ingredient.
  async getInventoryMovement(filters: ReportFilters): Promise<InventoryMovementReportRow[]> {
    const range = dateRangeFilter(filters);
    const movements = await prisma.inventoryStockMovement.findMany({
      where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      include: { branch: { select: { name: true } }, inventoryItem: { select: { name: true } }, unit: { select: { code: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    });
    const recorderIds = [...new Set(movements.map((m) => m.performedByUserId).filter((id): id is string => id !== null))];
    const recorders = recorderIds.length
      ? await prisma.user.findMany({ where: { id: { in: recorderIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const recorderNameById = new Map(recorders.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    return movements.map((m) => ({
      movement_id: m.id,
      branch_id: m.branchId,
      branch_name: m.branch.name,
      ingredient_id: m.inventoryItemId,
      ingredient_name: m.inventoryItem.name,
      // The movement's own recorded unit (e.g. a delivery logged in boxes),
      // not the ingredient's base unit — those can differ, and the
      // Inventory Movement screen (reports-view.tsx) reads unit_id off the
      // movement itself, so the CSV must match it row-for-row.
      unit: m.unit ? m.unit.code : '—',
      movement_type: m.movementType,
      quantity_change: m.quantityChange.toNumber(),
      quantity_before: m.quantityBefore.toNumber(),
      quantity_after: m.quantityAfter.toNumber(),
      reference_type: m.referenceType,
      reference_id: m.referenceId,
      notes: m.notes,
      recorded_by_name: m.performedByUserId ? (recorderNameById.get(m.performedByUserId) ?? null) : null,
      created_at: m.createdAt.toISOString(),
    }));
  },

  // Aggregated sale-driven consumption (movement_type SALE only), grouped by
  // ingredient + branch over the filtered range. Distinct from
  // getInventoryMovement above (the raw per-movement ledger, every movement
  // type) — this rolls SALE deductions up into one row per ingredient/branch.
  // unit_cost is InventoryItem-level (org-wide), not the branch InventoryStock
  // override getInventoryValuation prefers, since this is a movement-log
  // aggregate, not a point-in-time stock snapshot.
  async getInventoryConsumptionSummary(filters: ReportFilters): Promise<InventoryConsumptionSummaryReportRow[]> {
    const range = dateRangeFilter(filters);
    const movements = await prisma.inventoryStockMovement.findMany({
      where: { movementType: 'SALE', ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) },
      select: {
        branchId: true,
        inventoryItemId: true,
        quantityChange: true,
        branch: { select: { name: true } },
        inventoryItem: { select: { name: true, unitCost: true, baseUnit: { select: { code: true } } } },
      },
    });

    interface Bucket {
      branchName: string;
      ingredientName: string;
      unit: string;
      unitCost: number | null;
      quantityConsumed: number;
      movementCount: number;
    }
    const buckets = new Map<string, Bucket>();
    for (const m of movements) {
      const key = `${m.branchId}:${m.inventoryItemId}`;
      const consumed = Math.abs(m.quantityChange.toNumber());
      const existing = buckets.get(key);
      if (existing) {
        existing.quantityConsumed += consumed;
        existing.movementCount += 1;
      } else {
        buckets.set(key, {
          branchName: m.branch.name,
          ingredientName: m.inventoryItem.name,
          unit: m.inventoryItem.baseUnit.code,
          unitCost: m.inventoryItem.unitCost?.toNumber() ?? null,
          quantityConsumed: consumed,
          movementCount: 1,
        });
      }
    }

    return Array.from(buckets.entries())
      .map(([key, b]) => {
        const [branchId, ingredientId] = key.split(':') as [string, string];
        return {
          ingredient_id: ingredientId,
          ingredient_name: b.ingredientName,
          branch_id: branchId,
          branch_name: b.branchName,
          unit: b.unit,
          quantity_consumed: round2(b.quantityConsumed),
          unit_cost: b.unitCost,
          consumption_value: b.unitCost !== null ? round2(b.quantityConsumed * b.unitCost) : 0,
          movement_count: b.movementCount,
        };
      })
      .sort((a, b) => b.consumption_value - a.consumption_value);
  },

  // Per-ingredient live stock snapshot — deliberately ignores filters.dateFrom/
  // dateTo (unlike every other realtime report here): "opening stock today",
  // "consumed today/this month" and "remaining" are always anchored to *now*,
  // not an arbitrary selected range. opening_stock is derived, not stored —
  // current InventoryStock.quantityOnHand minus every movement (any type)
  // recorded today, which algebraically reconstructs the balance as it stood
  // at today's Manila midnight. consumed_today/consumed_this_month count only
  // SALE movements, matching the Branch Inventory list's "Consumed Today"
  // column (getConsumedTodayByBranch) for consistency across the app.
  async getInventorySummary(filters: ReportFilters): Promise<InventorySummaryReportRow[]> {
    const now = new Date();
    const { dayStart, dayEnd } = dayBounds(now);
    const { monthStart, monthEnd } = monthBounds(now);

    const stocks = await prisma.inventoryStock.findMany({
      where: {
        ...(filters.branchId && { branchId: filters.branchId }),
        inventoryItem: { deletedAt: null, trackInventory: true },
      },
      select: {
        branchId: true,
        inventoryItemId: true,
        quantityOnHand: true,
        branch: { select: { name: true } },
        inventoryItem: { select: { name: true, baseUnitId: true, baseUnit: { select: { code: true, dimension: true } } } },
      },
      orderBy: { inventoryItem: { name: 'asc' } },
    });
    if (stocks.length === 0) return [];

    const itemIds = Array.from(new Set(stocks.map((s) => s.inventoryItemId)));
    const branchIds = Array.from(new Set(stocks.map((s) => s.branchId)));
    const movementScope = { inventoryItemId: { in: itemIds }, branchId: { in: branchIds } };

    const [todayNet, todaySales, monthSales, kilogramUnit] = await Promise.all([
      prisma.inventoryStockMovement.groupBy({
        by: ['branchId', 'inventoryItemId'],
        where: { ...movementScope, createdAt: { gte: dayStart, lte: dayEnd } },
        _sum: { quantityChange: true },
      }),
      prisma.inventoryStockMovement.groupBy({
        by: ['branchId', 'inventoryItemId'],
        where: { ...movementScope, movementType: 'SALE', createdAt: { gte: dayStart, lte: dayEnd } },
        _sum: { quantityChange: true },
      }),
      prisma.inventoryStockMovement.groupBy({
        by: ['branchId', 'inventoryItemId'],
        where: { ...movementScope, movementType: 'SALE', createdAt: { gte: monthStart, lte: monthEnd } },
        _sum: { quantityChange: true },
      }),
      prisma.unitOfMeasure.findUnique({ where: { code: 'kg' } }),
    ]);

    const toMap = (rows: typeof todayNet, abs: boolean) =>
      new Map(rows.map((r) => [`${r.branchId}:${r.inventoryItemId}`, abs ? Math.abs(r._sum.quantityChange?.toNumber() ?? 0) : (r._sum.quantityChange?.toNumber() ?? 0)]));
    const todayNetMap = toMap(todayNet, false);
    const todaySalesMap = toMap(todaySales, true);
    const monthSalesMap = toMap(monthSales, true);

    // Weight (kilogram) auto-conversion, cached per base unit so each
    // distinct unit is resolved at most once regardless of row count.
    // Task 110: Section 1 (Ingredient Consumption (KG)) admits a base unit
    // when its dimension is WEIGHT (g, kg, and any future weight unit), or
    // when its code is tbsp/tsp — those two are UnitDimension.VOLUME in this
    // schema, but the spec explicitly calls for converting them to kg via
    // an existing UnitConversion row (e.g. a seasoning tracked by the
    // tablespoon). Every other unit (pieces, mL, L, ...) is NOT_APPLICABLE:
    // no factor is fabricated and no row is emitted at all.
    // Task 112: g and kg convert deterministically (value / 1000, identity)
    // — the standard metric relationship must never depend on a manually
    // configured UnitConversion row. Every other weight-eligible unit (other
    // WEIGHT units, tbsp, tsp) still goes through convertQuantity's
    // UnitConversion lookup; when that throws UnitConversionError (no row
    // configured), the unit is UNRESOLVED — eligible for kg tracking but not
    // convertible yet — so the caller keeps it in INGREDIENT_KG with status
    // CONVERSION_REQUIRED (Task 114) instead of silently dropping it or
    // routing it to a separate section.
    const WEIGHT_ELIGIBLE_CODES = new Set(['tbsp', 'tsp']);
    type WeightResolution = { status: 'resolved'; toKilograms: number } | { status: 'unresolved' } | { status: 'not_applicable' };
    // Keyed by `${inventoryItemId}:${baseUnitId}`, not baseUnitId alone —
    // two items sharing a base unit (e.g. two tbsp-tracked seasonings) can
    // resolve to different kg factors via their own InventoryItemUnitConversion
    // row, so a bare-baseUnitId cache would silently leak one item's factor
    // onto another's rows.
    const weightFactorCache = new Map<string, WeightResolution>();
    async function resolveWeightFactors(inventoryItemId: string, baseUnitId: string, dimension: string, code: string): Promise<WeightResolution> {
      const cacheKey = `${inventoryItemId}:${baseUnitId}`;
      const cached = weightFactorCache.get(cacheKey);
      if (cached) return cached;

      const normalizedCode = code.toLowerCase();
      const isWeightEligible = dimension === 'WEIGHT' || WEIGHT_ELIGIBLE_CODES.has(normalizedCode);
      if (!isWeightEligible) {
        const result: WeightResolution = { status: 'not_applicable' };
        weightFactorCache.set(cacheKey, result);
        return result;
      }
      if (normalizedCode === 'g') {
        const result: WeightResolution = { status: 'resolved', toKilograms: 0.001 };
        weightFactorCache.set(cacheKey, result);
        return result;
      }
      if (normalizedCode === 'kg') {
        const result: WeightResolution = { status: 'resolved', toKilograms: 1 };
        weightFactorCache.set(cacheKey, result);
        return result;
      }
      if (!kilogramUnit) {
        const result: WeightResolution = { status: 'unresolved' };
        weightFactorCache.set(cacheKey, result);
        return result;
      }
      try {
        const toKilograms = (await convertQuantity(1, baseUnitId, kilogramUnit.id, inventoryItemId)).toNumber();
        const result: WeightResolution = { status: 'resolved', toKilograms };
        weightFactorCache.set(cacheKey, result);
        return result;
      } catch (error) {
        if (error instanceof UnitConversionError) {
          const result: WeightResolution = { status: 'unresolved' };
          weightFactorCache.set(cacheKey, result);
          return result;
        }
        throw error;
      }
    }

    const rows: InventorySummaryReportRow[] = [];
    for (const s of stocks) {
      const key = `${s.branchId}:${s.inventoryItemId}`;
      const remaining = s.quantityOnHand.toNumber();
      const opening = remaining - (todayNetMap.get(key) ?? 0);
      const consumedToday = todaySalesMap.get(key) ?? 0;
      const consumedMonth = monthSalesMap.get(key) ?? 0;
      const dimension = s.inventoryItem.baseUnit.dimension;

      const base = {
        ingredient_id: s.inventoryItemId,
        ingredient_name: s.inventoryItem.name,
        branch_id: s.branchId,
        branch_name: s.branch.name,
        unit: s.inventoryItem.baseUnit.code,
        opening_stock: round2(opening),
        consumed_today: round2(consumedToday),
        consumed_this_month: round2(consumedMonth),
        remaining_stock: round2(remaining),
      };

      // Section 2 (Packaging Consumption (PC)): base unit dimension COUNT
      // (pc, cup, lid, tray, ...) — already piece-denominated, no conversion.
      if (dimension === 'COUNT') {
        rows.push({
          ...base,
          section: 'PACKAGING_PC',
          status: null,
          opening_stock_kg: null,
          consumed_today_kg: null,
          consumed_this_month_kg: null,
          remaining_kg: null,
          conversion_warning: null,
        });
        continue;
      }

      const resolution = await resolveWeightFactors(s.inventoryItemId, s.inventoryItem.baseUnitId, dimension, s.inventoryItem.baseUnit.code);

      // Not weight-normalizable and not COUNT (e.g. mL/L liquids) — excluded
      // entirely, there is no row for these at all.
      if (resolution.status === 'not_applicable') continue;

      // Task 114: weight-eligible (WEIGHT dimension, or tbsp/tsp) but no
      // resolvable path to kg — stays IN the Ingredient Consumption (KG)
      // table (never a separate section) with status CONVERSION_REQUIRED so
      // it isn't hidden, but its kg fields stay null and it's excluded from
      // kg totals by the export/UI layers.
      if (resolution.status === 'unresolved') {
        rows.push({
          ...base,
          section: 'INGREDIENT_KG',
          status: 'CONVERSION_REQUIRED',
          opening_stock_kg: null,
          consumed_today_kg: null,
          consumed_this_month_kg: null,
          remaining_kg: null,
          conversion_warning: 'Configure a valid conversion to kg',
        });
        continue;
      }

      // Section 1 (Ingredient Consumption (KG)).
      rows.push({
        ...base,
        section: 'INGREDIENT_KG',
        status: 'CONVERTED',
        opening_stock_kg: round2(opening * resolution.toKilograms),
        consumed_today_kg: round2(consumedToday * resolution.toKilograms),
        consumed_this_month_kg: round2(consumedMonth * resolution.toKilograms),
        remaining_kg: round2(remaining * resolution.toKilograms),
        conversion_warning: null,
      });
    }

    return rows;
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
      // _sum.subtotal (pre-discount) — matches lib/financial-metrics.ts's
      // canonical grossSales definition, see getDailySales.
      _sum: { subtotal: true },
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
          gross_sales: g._sum.subtotal?.toNumber() ?? 0,
          hours_worked: Math.round(((minutesByEmployee.get(g.cashierId) ?? 0) / 60) * 100) / 100,
        };
      })
      .sort((a, b) => b.gross_sales - a.gross_sales);
  },

  // Final reporting cutover (CR-007 §20): sourced from InventoryStock/InventoryItem
  // only — never Ingredient or InventoryMovement. Row shape (ingredient_id,
  // ingredient_name, ..., status: 'ok'|'low'|'critical') is unchanged for the
  // branch-analytics tab and CSV/PDF export; classifyStockStatus's 'healthy' is
  // mapped back to the existing 'ok' literal to preserve that contract.
  async getInventoryValuation(filters: ReportFilters): Promise<InventoryValuationReportRow[]> {
    const stocks = await prisma.inventoryStock.findMany({
      where: { inventoryItem: { deletedAt: null }, ...(filters.branchId && { branchId: filters.branchId }) },
      select: {
        branchId: true,
        inventoryItemId: true,
        quantityOnHand: true,
        lowStockThreshold: true,
        criticalThreshold: true,
        unitCost: true,
        inventoryItem: { select: { name: true, unitCost: true, baseUnit: { select: { code: true } } } },
      },
    });

    return stocks
      .map((stock) => {
        const currentStock = stock.quantityOnHand.toNumber();
        const lowThreshold = stock.lowStockThreshold?.toNumber() ?? null;
        const criticalThreshold = stock.criticalThreshold?.toNumber() ?? null;
        const unitCost = stock.unitCost?.toNumber() ?? stock.inventoryItem.unitCost?.toNumber() ?? null;
        const status = classifyStockStatus(currentStock, lowThreshold, criticalThreshold);
        return {
          ingredient_id: stock.inventoryItemId,
          ingredient_name: stock.inventoryItem.name,
          branch_id: stock.branchId,
          unit: stock.inventoryItem.baseUnit.code,
          current_stock: currentStock,
          unit_cost: unitCost,
          total_value: unitCost !== null ? Math.round(currentStock * unitCost * 100) / 100 : 0,
          status: (status === 'healthy' ? 'ok' : status) as 'ok' | 'low' | 'critical',
        };
      })
      .sort((a, b) => b.total_value - a.total_value);
  },

  // Admin Inventory Valuation rollup: sourced from InventoryStock/InventoryItem/Branch only
  // — never Ingredient or InventoryMovement. Distinct from getInventoryValuation above
  // (also InventoryStock-sourced post-cutover) by response shape and scope: this rollup
  // is always org-wide with no branchId filter/pagination (mirrors the existing "admin
  // rollup, no branch_id" semantics) and returns the AdminInventoryValuation* shape,
  // while getInventoryValuation supports branchId/pagination and the ok/low/critical
  // per-item row shape for the branch-analytics tab and CSV/PDF export.
  async getInventoryValuationRollup(): Promise<AdminInventoryValuationRollupResponse> {
    const [branches, stockRows, activeItemCount, movementMaxByBranch] = await Promise.all([
      prisma.branch.findMany({ select: { id: true, name: true } }),
      prisma.inventoryStock.findMany({
        where: { inventoryItem: { deletedAt: null } },
        select: {
          branchId: true,
          quantityOnHand: true,
          lowStockThreshold: true,
          criticalThreshold: true,
          unitCost: true,
          inventoryItem: { select: { unitCost: true } },
        },
      }),
      prisma.inventoryItem.count({ where: { deletedAt: null, trackInventory: true } }),
      prisma.inventoryStockMovement.groupBy({ by: ['branchId'], _max: { createdAt: true } }),
    ]);

    const lastMovementByBranch = new Map(movementMaxByBranch.map((m) => [m.branchId, m._max.createdAt]));

    interface BranchAccumulator {
      itemCount: number;
      totalValue: number;
      lowStockCount: number;
      criticalStockCount: number;
      outOfStockCount: number;
    }
    const accByBranch = new Map<string, BranchAccumulator>();

    for (const row of stockRows) {
      const acc = accByBranch.get(row.branchId) ?? { itemCount: 0, totalValue: 0, lowStockCount: 0, criticalStockCount: 0, outOfStockCount: 0 };
      const quantity = row.quantityOnHand.toNumber();
      const lowThreshold = row.lowStockThreshold?.toNumber() ?? null;
      const criticalThreshold = row.criticalThreshold?.toNumber() ?? null;
      const effectiveUnitCost = row.unitCost?.toNumber() ?? row.inventoryItem.unitCost?.toNumber() ?? null;
      const status = classifyStockStatus(quantity, lowThreshold, criticalThreshold);

      acc.itemCount += 1;
      acc.totalValue += effectiveUnitCost !== null ? quantity * effectiveUnitCost : 0;
      if (status === 'low') acc.lowStockCount += 1;
      if (status === 'critical') acc.criticalStockCount += 1;
      if (quantity <= 0) acc.outOfStockCount += 1;

      accByBranch.set(row.branchId, acc);
    }

    const branchRows = branches
      .map((branch) => {
        const acc = accByBranch.get(branch.id) ?? { itemCount: 0, totalValue: 0, lowStockCount: 0, criticalStockCount: 0, outOfStockCount: 0 };
        return {
          branch_id: branch.id,
          branch_name: branch.name,
          inventory_item_count: acc.itemCount,
          total_inventory_value: round2(acc.totalValue),
          low_stock_count: acc.lowStockCount,
          critical_stock_count: acc.criticalStockCount,
          out_of_stock_count: acc.outOfStockCount,
          last_movement_at: lastMovementByBranch.get(branch.id)?.toISOString() ?? null,
        };
      })
      .sort((a, b) => b.total_inventory_value - a.total_inventory_value);

    const summary = branchRows.reduce(
      (acc, row) => ({
        total_inventory_value: round2(acc.total_inventory_value + row.total_inventory_value),
        total_active_inventory_items: activeItemCount,
        total_inventory_stock_rows: acc.total_inventory_stock_rows + row.inventory_item_count,
        total_low_stock_rows: acc.total_low_stock_rows + row.low_stock_count,
        total_critical_stock_rows: acc.total_critical_stock_rows + row.critical_stock_count,
        total_out_of_stock_rows: acc.total_out_of_stock_rows + row.out_of_stock_count,
      }),
      {
        total_inventory_value: 0,
        total_active_inventory_items: activeItemCount,
        total_inventory_stock_rows: 0,
        total_low_stock_rows: 0,
        total_critical_stock_rows: 0,
        total_out_of_stock_rows: 0,
      },
    );

    return { generated_at: new Date().toISOString(), branches: branchRows, summary };
  },

  // Final reporting cutover (CR-007 §20): low-stock counts are sourced from
  // InventoryStock only — never Ingredient or InventoryMovement. The
  // low_stock_ingredient_count field name is unchanged for API compatibility.
  async getBranchComparison(filters: ReportFilters): Promise<BranchComparisonReportRow[]> {
    const range = dateRangeFilter(filters);
    const [salesGrouped, activeShifts, stocks, branches] = await Promise.all([
      // _sum.subtotal (pre-discount), not totalAmount (post-discount) — matches
      // lib/financial-metrics.ts's canonical grossSales definition, see getDailySales.
      prisma.transaction.groupBy({ by: ['branchId'], where: { status: 'completed', ...(range && { createdAt: range }) }, _sum: { subtotal: true }, _count: { _all: true } }),
      prisma.shift.findMany({ where: { status: 'active' }, select: { branchId: true } }),
      prisma.inventoryStock.findMany({ where: { inventoryItem: { deletedAt: null } }, select: { branchId: true, quantityOnHand: true, lowStockThreshold: true } }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);

    const activeShiftCountByBranch = new Map<string, number>();
    for (const shift of activeShifts) activeShiftCountByBranch.set(shift.branchId, (activeShiftCountByBranch.get(shift.branchId) ?? 0) + 1);

    const lowStockCountByBranch = new Map<string, number>();
    for (const stock of stocks) {
      const lowThreshold = stock.lowStockThreshold?.toNumber() ?? null;
      if (lowThreshold !== null && stock.quantityOnHand.toNumber() <= lowThreshold) {
        lowStockCountByBranch.set(stock.branchId, (lowStockCountByBranch.get(stock.branchId) ?? 0) + 1);
      }
    }

    const salesByBranch = new Map(salesGrouped.map((g) => [g.branchId, g]));
    return branches
      .map((branch) => {
        const sales = salesByBranch.get(branch.id);
        return {
          branch_id: branch.id,
          branch_name: branch.name,
          gross_sales: sales?._sum.subtotal?.toNumber() ?? 0,
          transaction_count: sales?._count._all ?? 0,
          active_shift_count: activeShiftCountByBranch.get(branch.id) ?? 0,
          low_stock_ingredient_count: lowStockCountByBranch.get(branch.id) ?? 0,
        };
      })
      .sort((a, b) => b.gross_sales - a.gross_sales);
  },

  // Sourced from InventoryStock/InventoryItem/InventoryStockMovement only —
  // never Ingredient or InventoryMovement (CR-007 §20 analytics cutover).
  // InventoryItem is shared across branches, so each (branchId,
  // inventoryItemId) pair is the equivalent of the old per-branch Ingredient
  // row; composite-keying preserves prior report granularity (same item at
  // two branches still surfaces as two rows, as two Ingredient rows would
  // have before).
  async getInventoryAnalytics(params: { branchId?: string; dateFrom: Date; dateTo: Date; periodDays: number }): Promise<InventoryAnalyticsReport> {
    const REORDER_LOOKBACK_DAYS = 30;
    const REORDER_COVERAGE_DAYS = 14;
    const REORDER_THRESHOLD_MULTIPLIER = 1.5;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const { branchId, dateFrom, dateTo, periodDays } = params;
    const branchWhere = branchId ? { branchId } : {};
    const reorderLookbackFrom = new Date(dateTo.getTime() - REORDER_LOOKBACK_DAYS * MS_PER_DAY);
    const stockKey = (b: string, itemId: string) => `${b}::${itemId}`;

    const [consumptionGrouped, wasteMovements, lastMovementGrouped, reorderConsumptionGrouped, stocks, branches, totalMovements] = await Promise.all([
      prisma.inventoryStockMovement.groupBy({
        by: ['inventoryItemId', 'branchId'],
        where: { movementType: 'SALE', createdAt: { gte: dateFrom, lte: dateTo }, ...branchWhere },
        _sum: { quantityChange: true },
      }),
      prisma.inventoryStockMovement.findMany({
        where: { movementType: 'WASTE', createdAt: { gte: dateFrom, lte: dateTo }, ...branchWhere },
        select: { quantityChange: true, createdAt: true, inventoryItemId: true, branchId: true },
      }),
      prisma.inventoryStockMovement.groupBy({ by: ['inventoryItemId', 'branchId'], where: { ...branchWhere }, _max: { createdAt: true } }),
      prisma.inventoryStockMovement.groupBy({
        by: ['inventoryItemId', 'branchId'],
        where: { movementType: 'SALE', createdAt: { gte: reorderLookbackFrom, lte: dateTo }, ...branchWhere },
        _sum: { quantityChange: true },
      }),
      prisma.inventoryStock.findMany({
        where: { inventoryItem: { deletedAt: null }, ...branchWhere },
        select: {
          branchId: true,
          inventoryItemId: true,
          quantityOnHand: true,
          lowStockThreshold: true,
          unitCost: true,
          inventoryItem: { select: { name: true, unitCost: true, baseUnit: { select: { code: true } } } },
        },
      }),
      prisma.branch.findMany({ select: { id: true, name: true } }),
      prisma.inventoryStockMovement.count({ where: { createdAt: { gte: dateFrom, lte: dateTo }, ...branchWhere } }),
    ]);

    const stockByKey = new Map(
      stocks.map((s) => [
        stockKey(s.branchId, s.inventoryItemId),
        {
          inventoryItemId: s.inventoryItemId,
          branchId: s.branchId,
          name: s.inventoryItem.name,
          unit: s.inventoryItem.baseUnit.code,
          currentStock: s.quantityOnHand.toNumber(),
          lowStockThreshold: s.lowStockThreshold?.toNumber() ?? null,
          unitCost: s.unitCost?.toNumber() ?? s.inventoryItem.unitCost?.toNumber() ?? null,
        },
      ]),
    );
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    const lastMovementByKey = new Map(lastMovementGrouped.map((m) => [stockKey(m.branchId, m.inventoryItemId), m._max.createdAt]));

    const consumption = consumptionGrouped
      .map((g) => ({ stock: stockByKey.get(stockKey(g.branchId, g.inventoryItemId)), totalConsumed: Math.abs(g._sum.quantityChange?.toNumber() ?? 0) }))
      .filter((c): c is { stock: NonNullable<typeof c.stock>; totalConsumed: number } => c.stock !== undefined);

    const fastMovers = [...consumption]
      .sort((a, b) => b.totalConsumed - a.totalConsumed)
      .slice(0, 10)
      .map((c) => ({
        ingredient_id: c.stock.inventoryItemId,
        name: c.stock.name,
        unit: c.stock.unit,
        total_consumed: c.totalConsumed,
        avg_daily_consumption: Math.round((c.totalConsumed / periodDays) * 1000) / 1000,
      }));

    const slowMovers = [...consumption]
      .sort((a, b) => a.totalConsumed - b.totalConsumed)
      .slice(0, 10)
      .map((c) => {
        const lastMovement = lastMovementByKey.get(stockKey(c.stock.branchId, c.stock.inventoryItemId)) ?? null;
        return {
          ingredient_id: c.stock.inventoryItemId,
          name: c.stock.name,
          unit: c.stock.unit,
          total_consumed: c.totalConsumed,
          days_since_last_movement: lastMovement ? Math.floor((dateTo.getTime() - lastMovement.getTime()) / MS_PER_DAY) : null,
        };
      });

    const wasteByDay = new Map<string, { quantity: number; cost: number }>();
    for (const w of wasteMovements) {
      const day = manilaDateKey(w.createdAt);
      const qty = Math.abs(w.quantityChange.toNumber());
      const unitCost = stockByKey.get(stockKey(w.branchId, w.inventoryItemId))?.unitCost ?? 0;
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
    // units (kg, pieces, L) across items only works once costed.
    const consumedCostByBranch = new Map<string, number>();
    for (const c of consumption) {
      const unitCost = c.stock.unitCost ?? 0;
      consumedCostByBranch.set(c.stock.branchId, (consumedCostByBranch.get(c.stock.branchId) ?? 0) + c.totalConsumed * unitCost);
    }
    const inventoryValueByBranch = new Map<string, number>();
    for (const stock of stockByKey.values()) {
      const unitCost = stock.unitCost ?? 0;
      inventoryValueByBranch.set(stock.branchId, (inventoryValueByBranch.get(stock.branchId) ?? 0) + stock.currentStock * unitCost);
    }
    const branchIdsWithData = branchId ? [branchId] : [...new Set([...stockByKey.values()].map((s) => s.branchId))];
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

    const reorderConsumedByKey = new Map(
      reorderConsumptionGrouped.map((g) => [stockKey(g.branchId, g.inventoryItemId), Math.abs(g._sum.quantityChange?.toNumber() ?? 0)]),
    );
    const reorderRecommendations = [...stockByKey.values()]
      .filter((s) => s.lowStockThreshold !== null && s.currentStock <= s.lowStockThreshold * REORDER_THRESHOLD_MULTIPLIER)
      .map((s) => {
        const avgDailyConsumption = (reorderConsumedByKey.get(stockKey(s.branchId, s.inventoryItemId)) ?? 0) / REORDER_LOOKBACK_DAYS;
        const daysUntilStockout = avgDailyConsumption > 0 ? Math.round((s.currentStock / avgDailyConsumption) * 10) / 10 : null;
        return {
          ingredient_id: s.inventoryItemId,
          name: s.name,
          current_stock: s.currentStock,
          avg_daily_consumption: Math.round(avgDailyConsumption * 1000) / 1000,
          days_until_stockout: daysUntilStockout,
          recommended_reorder_qty: Math.round(avgDailyConsumption * REORDER_COVERAGE_DAYS * 1000) / 1000,
        };
      })
      .sort((a, b) => (a.days_until_stockout ?? Infinity) - (b.days_until_stockout ?? Infinity));

    const totalWasteCost = wasteTrends.reduce((sum, w) => sum + w.total_waste_cost, 0);
    const totalConsumptionCost = consumption.reduce((sum, c) => sum + c.totalConsumed * (c.stock.unitCost ?? 0), 0);
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

  // reportType here is $Enums.ReportType (the Postgres-backed enum on
  // ReportSnapshot), a strict subset of the shared ReportType union — only
  // PRECOMPUTED_TYPES in reports.service.ts ever reach this table. Realtime
  // types like INVENTORY_CONSUMPTION_SUMMARY are never snapshotted, so this
  // is intentionally narrower than the app-wide ReportType.
  async saveSnapshot(reportType: $Enums.ReportType, branchId: string | null, data: unknown, parameters: unknown): Promise<void> {
    const created = await prisma.reportSnapshot.create({
      data: { reportType, branchId, payload: data as Prisma.InputJsonValue, parameters: parameters as Prisma.InputJsonValue },
    });
    // Keep only the latest snapshot per (reportType, branchId) — refreshes
    // happen every 15 min under stale-while-revalidate, so without this the
    // table grows without bound.
    await prisma.reportSnapshot.deleteMany({ where: { reportType, branchId, id: { not: created.id } } });
  },

  async getLatestSnapshot(reportType: $Enums.ReportType, branchId: string | null) {
    return prisma.reportSnapshot.findFirst({ where: { reportType, branchId }, orderBy: { computedAt: 'desc' } });
  },

  async countRows(reportType: ReportType, filters: ReportFilters): Promise<number> {
    const range = dateRangeFilter(filters);
    switch (reportType) {
      case 'VOID_REFUND':
        return prisma.transaction.count({ where: { status: { in: ['voided', 'refunded'] }, ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
      case 'INVENTORY_MOVEMENT':
        return prisma.inventoryStockMovement.count({ where: { ...(filters.branchId && { branchId: filters.branchId }), ...(range && { createdAt: range }) } });
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
      case 'INVENTORY_CONSUMPTION_SUMMARY':
        return this.getInventoryConsumptionSummary(filters).then((rows) => rows.length);
      case 'INVENTORY_SUMMARY':
        return this.getInventorySummary(filters).then((rows) => rows.length);
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
        action: {
          in: [
            'LOGIN_SUCCESS',
            'LOGIN_FAILURE',
            'LOGOUT',
            'LOGOUT_ALL_DEVICES',
            'PIN_LOGIN_SUCCESS',
            'ACCOUNT_UNLOCKED',
            'VOID_TRANSACTION',
            'REFUND_TRANSACTION',
          ],
        },
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
