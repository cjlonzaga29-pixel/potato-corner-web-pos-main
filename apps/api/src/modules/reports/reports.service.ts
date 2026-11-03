import { REPORT_EXPORT_ROW_LIMITS, ROLES, expenseDisplayName } from '@potato-corner/shared';
import type { ReportType, InventorySummaryResponse, ReportPeriodSummary } from '@potato-corner/shared';
import type { $Enums } from '@prisma/client';
import { reportsRepository } from './reports.repository.js';
import type { ReportColumn, ReportFilters, ReportResponse, SnapshotResponse } from './reports.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getReportRows, REPORT_COLUMNS, DAILY_SALES_TRANSACTION_COLUMNS, DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS, SOLD_PRODUCT_TRANSACTION_COLUMNS } from './reports.columns.js';
import { ReportError } from './reports.types.js';
import { generateCsv } from '../../lib/reports/csv.js';
import { generatePdf } from '../../lib/reports/pdf.js';
import { generateInventorySummaryCsv, generateInventorySummaryPdf } from '../../lib/reports/inventory-summary-export.js';
import { generateExpensesPdf, formatPhp, EXPENSES_EXPORT_COLUMNS, type ExpensesExportRow } from '../../lib/reports/expenses-export.js';
import { buildExportFilename } from '../../lib/reports/export-filename.js';
import { dailySalesExportCoverage, discountExportCoverage, expensesExportCoverage, exportCoverage, soldProductsExportCoverage, voidRefundExportCoverage, type ExportCoverage } from '../../lib/reports/export-coverage.js';
import { prisma } from '../../lib/prisma.js';
import { enqueueGenerateExport, enqueueRefreshSnapshot } from '../../queues/report.queue.js';
import { expensesRepository } from '../expenses/expenses.repository.js';
import type { ExpenseFilters } from '../expenses/expenses.types.js';
import { manilaDateKey } from '../../lib/manila-time.js';

const DEFAULT_REALTIME_RANGE_DAYS = 7;

function defaultRealtimeFilters(filters: ReportFilters): ReportFilters {
  if (filters.dateFrom || filters.dateTo) return filters;
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - DEFAULT_REALTIME_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { ...filters, dateFrom, dateTo };
}

/**
 * discount_id_reference carries a decrypted PWD/Senior Citizen government ID
 * — same supervisor/super_admin-only rule getDiscountAuditTrail already
 * enforces. DAILY_SALES_TRANSACTION_COLUMNS/DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS
 * are flat arrays with no role awareness, and the 'branch' role reaches both
 * export branches below (adminSupervisorOrBranch), so the column must be
 * stripped here or a branch/staff export would leak it.
 */
function scopeDiscountIdColumn<T extends { key: string }>(columns: T[], requesterRole: string): T[] {
  if (requesterRole === ROLES.SUPERVISOR || requesterRole === ROLES.SUPER_ADMIN) return columns;
  return columns.filter((c) => c.key !== 'discount_id_reference');
}

function toWireFilters(filters: ReportFilters) {
  return {
    branch_id: filters.branchId,
    date_from: filters.dateFrom?.toISOString(),
    date_to: filters.dateTo?.toISOString(),
    page: filters.page,
    limit: filters.limit,
    ...(filters.discountKey && { discount_key: filters.discountKey }),
  };
}

async function accessAudit(reportType: ReportType, filters: ReportFilters, actorId: string, actorRole: string, rowCount: number): Promise<void> {
  await recordAuditLog({
    action: 'REPORT_ACCESSED',
    entityType: 'report',
    entityId: reportType,
    actorId,
    actorRole,
    branchId: filters.branchId ?? null,
    afterState: { reportType, filters: toWireFilters(filters), rowCount },
  });
}

// These six report types are already paginated inside the repository
// (skip/take applied in the Prisma query) — fetchRows returns exactly one
// page, so the true `total` must come from a separate count, and the
// result must not be re-sliced. The remaining two real-time types
// (DAILY_SALES, DISCOUNT_COMPLIANCE) aggregate in memory and return every
// matching row, so they still need client-side slicing here.
const REPOSITORY_PAGINATED_TYPES = new Set<ReportType>([
  'SHIFT_SUMMARY',
  'CASH_RECONCILIATION',
  'VOID_REFUND',
  'INVENTORY_MOVEMENT',
  'ATTENDANCE_SUMMARY',
  'FRAUD_ALERT_SUMMARY',
  'AUDIT_LOG',
]);

async function realtimeReport<T>(
  reportType: ReportType,
  rawFilters: ReportFilters,
  actorId: string,
  actorRole: string,
  fetchRows: (filters: ReportFilters) => Promise<T[]>,
): Promise<ReportResponse<T>> {
  const filters = defaultRealtimeFilters(rawFilters);

  if (REPOSITORY_PAGINATED_TYPES.has(reportType)) {
    const [page, total] = await Promise.all([fetchRows(filters), reportsRepository.countRows(reportType, filters)]);
    await accessAudit(reportType, filters, actorId, actorRole, total);
    return {
      report_type: reportType,
      generated_at: new Date().toISOString(),
      filters: toWireFilters(filters),
      data: page,
      total,
      page: filters.page,
      limit: filters.limit,
    };
  }

  const allRows = await fetchRows(filters);
  const start = (filters.page - 1) * filters.limit;
  const page = allRows.slice(start, start + filters.limit);

  await accessAudit(reportType, filters, actorId, actorRole, allRows.length);

  return {
    report_type: reportType,
    generated_at: new Date().toISOString(),
    filters: toWireFilters(filters),
    data: page,
    total: allRows.length,
    page: filters.page,
    limit: filters.limit,
  };
}

const INVENTORY_ANALYTICS_PERIOD_DAYS: Record<'7d' | '30d' | '90d' | '1yr', number> = { '7d': 7, '30d': 30, '90d': 90, '1yr': 365 };

function inventoryAnalyticsDateRange(period: '7d' | '30d' | '90d' | '1yr'): { dateFrom: Date; dateTo: Date; periodDays: number } {
  const periodDays = INVENTORY_ANALYTICS_PERIOD_DAYS[period];
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - periodDays * 24 * 60 * 60 * 1000);
  return { dateFrom, dateTo, periodDays };
}

const PRECOMPUTED_WINDOW_DAYS = 30;
const SNAPSHOT_STALE_MS = 15 * 60 * 1000;

function precomputedWindowFilters(branchId: string | null): ReportFilters {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - PRECOMPUTED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { branchId: branchId ?? undefined, dateFrom, dateTo, page: 1, limit: 100 };
}

// reportType is $Enums.ReportType (the Postgres-backed ReportSnapshot enum) —
// narrower than the app-wide ReportType, matching PRECOMPUTED_TYPES below,
// since every call site passes one of those five literals.
async function precomputedReport<T>(
  reportType: $Enums.ReportType,
  branchId: string | null,
  actorId: string,
  actorRole: string,
): Promise<SnapshotResponse<T>> {
  const existing = await reportsRepository.getLatestSnapshot(reportType, branchId);

  if (!existing) {
    const filters = precomputedWindowFilters(branchId);
    const rows = (await getReportRows(reportType, filters)) as T[];
    await reportsRepository.saveSnapshot(reportType, branchId, rows, filters);
    await accessAudit(reportType, filters, actorId, actorRole, rows.length);
    return { report_type: reportType, computed_at: new Date().toISOString(), branch_id: branchId, data: rows };
  }

  const isStale = Date.now() - existing.computedAt.getTime() > SNAPSHOT_STALE_MS;
  if (isStale) {
    void enqueueRefreshSnapshot({ reportType, branchId, filters: precomputedWindowFilters(branchId) });
  }

  await accessAudit(reportType, { branchId: branchId ?? undefined, page: 1, limit: 100 }, actorId, actorRole, (existing.payload as T[]).length);
  return { report_type: reportType, computed_at: existing.computedAt.toISOString(), branch_id: branchId, data: existing.payload as T[] };
}

// POS-PERF-P59 — the row limit of every record-level export below. Rendering a PDF
// blocks the event loop, so a larger file makes every branch's checkout wait.
const SYNC_ROW_LIMIT: Record<'csv' | 'pdf', number> = REPORT_EXPORT_ROW_LIMITS;

// Admin's reports and the summary reports stay complete. At or above this they fall
// back to the async job + Supabase signed URL + Socket.io notification flow, which
// still renders in this process. Their row counts are normally small.
const ASYNC_EXPORT_THRESHOLD: Record<'csv' | 'pdf', number> = { csv: 10_000, pdf: 2_000 };

type ExportRow = Record<string, unknown>;

interface BoundedExportPlan {
  fetchRows: (limit: number) => Promise<ExportRow[]>;
  columns: ReportColumn<ExportRow>[];
  coverage: (rows: ExportRow[], hasMore: boolean) => ExportCoverage;
  filenameName?: string;
  title?: string;
}

function timestampSpan(rows: ExportRow[], key: string): { newestAt: string | undefined; oldestAt: string | undefined } {
  const read = (row: ExportRow | undefined) => {
    const value = row?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  return { newestAt: read(rows[0]), oldestAt: read(rows[rows.length - 1]) };
}

/** The Supervisor/Branch export for this report, or null when it is not record-level. */
function boundedExportPlan(reportType: ReportType, filters: ReportFilters, requesterRole: string): BoundedExportPlan | null {
  // The row and column types differ by report; the renderers only read rows by column key.
  const typed = <T,>(coverage: (rows: T[], hasMore: boolean) => ExportCoverage) => coverage as unknown as BoundedExportPlan['coverage'];
  const asColumns = <T,>(columns: T[]) => columns as unknown as BoundedExportPlan['columns'];
  const resolved = defaultRealtimeFilters(filters);

  switch (reportType) {
    case 'DAILY_SALES': {
      // Daily Sales and Sold Product Transactions list each sale, unlike Admin's per-day summary of this type.
      const isSoldView = resolved.reportView === 'sold_product_transactions';
      return {
        fetchRows: (limit) => reportsRepository.getDailySalesTransactions({ ...resolved, anyStatus: isSoldView, limit }) as Promise<ExportRow[]>,
        columns: asColumns(scopeDiscountIdColumn(isSoldView ? SOLD_PRODUCT_TRANSACTION_COLUMNS : DAILY_SALES_TRANSACTION_COLUMNS, requesterRole)),
        coverage: isSoldView ? typed(soldProductsExportCoverage) : typed(dailySalesExportCoverage),
        ...(isSoldView && { filenameName: 'SoldProductTransactions', title: 'Sold Product Transactions' }),
      };
    }
    case 'VOID_REFUND':
      return {
        fetchRows: (limit) => reportsRepository.getVoidRefundForExport({ ...resolved, limit }) as Promise<ExportRow[]>,
        columns: REPORT_COLUMNS[reportType],
        coverage: typed(voidRefundExportCoverage),
      };
    case 'DISCOUNT_COMPLIANCE':
      // Filtered in the query, not after it: taking the newest sales first and
      // filtering afterwards could leave exported rows short of the screen's totals.
      return {
        fetchRows: (limit) => reportsRepository.getDailySalesTransactions({ ...resolved, discountedOnly: true, limit }) as Promise<ExportRow[]>,
        columns: asColumns(scopeDiscountIdColumn(DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS, requesterRole)),
        coverage: typed(discountExportCoverage),
      };
    case 'INVENTORY_MOVEMENT':
      return {
        fetchRows: (limit) => reportsRepository.getInventoryMovement({ ...resolved, page: 1, limit }) as Promise<ExportRow[]>,
        columns: REPORT_COLUMNS[reportType],
        coverage: (rows, hasMore) => exportCoverage(rows.length, hasMore, { noun: 'stock movements', screen: 'Inventory Movement', ...timestampSpan(rows, 'created_at') }),
      };
    case 'ATTENDANCE_SUMMARY':
      return {
        fetchRows: (limit) => reportsRepository.getAttendanceSummary({ ...resolved, page: 1, limit }) as Promise<ExportRow[]>,
        columns: REPORT_COLUMNS[reportType],
        coverage: (rows, hasMore) => exportCoverage(rows.length, hasMore, { noun: 'attendance records', screen: 'Attendance Summary', ...timestampSpan(rows, 'clock_in') }),
      };
    // No Supervisor screen exports these two; a direct request still may not exceed the PDF limit.
    case 'SHIFT_SUMMARY':
      return {
        fetchRows: (limit) => reportsRepository.getShiftSummary({ ...resolved, page: 1, limit }) as Promise<ExportRow[]>,
        columns: REPORT_COLUMNS[reportType],
        coverage: (rows, hasMore) => exportCoverage(rows.length, hasMore, { noun: 'shifts', screen: 'Shift Summary', ...timestampSpan(rows, 'started_at') }),
      };
    case 'CASH_RECONCILIATION':
      return {
        fetchRows: (limit) => reportsRepository.getCashReconciliation({ ...resolved, page: 1, limit }) as Promise<ExportRow[]>,
        columns: REPORT_COLUMNS[reportType],
        coverage: (rows, hasMore) => exportCoverage(rows.length, hasMore, { noun: 'closed shifts', screen: 'Cash Reconciliation', newestAt: undefined, oldestAt: undefined }),
      };
    default:
      return null;
  }
}

async function runBoundedExport(
  reportType: ReportType,
  filters: ReportFilters,
  format: 'csv' | 'pdf',
  requesterId: string,
  requesterRole: string,
  branchId: string | null,
  plan: BoundedExportPlan,
): Promise<ExportResult> {
  // One row past the limit tells a file that stopped at the limit from one that merely holds exactly that many.
  const rowLimit = SYNC_ROW_LIMIT[format];
  const fetched = await plan.fetchRows(rowLimit + 1);
  const rows = fetched.slice(0, rowLimit);
  const coverage = plan.coverage(rows, fetched.length > rowLimit);
  const filename = buildExportFilename(reportType, format, filters, { partial: coverage.partial, name: plan.filenameName });

  let buffer: Buffer;
  let contentType: 'text/csv' | 'application/pdf';
  if (format === 'csv') {
    // A complete CSV stays exactly as it was: a first line would only shift the headers of a file nothing is missing from.
    buffer = generateCsv(rows, plan.columns, coverage.partial ? coverage.note : undefined);
    contentType = 'text/csv';
  } else {
    const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
    buffer = await generatePdf(reportType, filters, rows, plan.columns, branch?.name ?? null, coverage, plan.title);
    contentType = 'application/pdf';
  }

  await recordAuditLog({
    action: 'REPORT_EXPORTED',
    entityType: 'report',
    entityId: reportType,
    actorId: requesterId,
    actorRole: requesterRole,
    branchId,
    afterState: { reportType, format, async: false, rowCount: rows.length, partial: coverage.partial },
  });
  return { kind: 'file', buffer, filename, contentType };
}

const SUPER_ADMIN_ONLY_TYPES = new Set<ReportType>(['FRAUD_ALERT_SUMMARY', 'BRANCH_COMPARISON', 'AUDIT_LOG']);
const PRECOMPUTED_TYPES = new Set<ReportType>(['PRODUCT_PERFORMANCE', 'FLAVOR_PERFORMANCE', 'EMPLOYEE_PERFORMANCE', 'INVENTORY_VALUATION', 'BRANCH_COMPARISON']);

export type ExportResult =
  | { kind: 'file'; buffer: Buffer; filename: string; contentType: 'text/csv' | 'application/pdf' }
  | { kind: 'job'; job_id: string; message: string; estimated_seconds: number };

export const reportsService = {
  getDailySalesReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('DAILY_SALES', filters, actorId, actorRole, (f) => reportsRepository.getDailySales(f)),
  getShiftSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('SHIFT_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getShiftSummary(f)),
  getCashReconciliationReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('CASH_RECONCILIATION', filters, actorId, actorRole, (f) => reportsRepository.getCashReconciliation(f)),
  getVoidRefundReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('VOID_REFUND', filters, actorId, actorRole, (f) => reportsRepository.getVoidRefund(f)),
  getDiscountComplianceReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('DISCOUNT_COMPLIANCE', filters, actorId, actorRole, (f) => reportsRepository.getDiscountCompliance(f)),
  getInventoryMovementReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('INVENTORY_MOVEMENT', filters, actorId, actorRole, (f) => reportsRepository.getInventoryMovement(f)),
  getInventoryConsumptionSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('INVENTORY_CONSUMPTION_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getInventoryConsumptionSummary(f)),
  // POS-PERF-P59 — bespoke for the same reason as the summary below. branchGuard
  // has already verified access to filters.branchId at the router.
  async getReportPeriodSummary(filters: ReportFilters, actorId: string, actorRole: string): Promise<ReportPeriodSummary> {
    const resolved = defaultRealtimeFilters(filters);
    const summary = await reportsRepository.getReportPeriodSummary(resolved);
    await recordAuditLog({
      action: 'REPORT_ACCESSED',
      entityType: 'report',
      entityId: 'REPORT_PERIOD_SUMMARY',
      actorId,
      actorRole,
      branchId: resolved.branchId ?? null,
      afterState: { reportType: 'REPORT_PERIOD_SUMMARY', filters: toWireFilters(resolved) },
    });
    return summary;
  },
  // Bespoke rather than realtimeReport -- this returns one summary object,
  // not a data[]/total page, so it doesn't fit ReportResponse<T>. Mirrors
  // getInventoryAnalyticsReport's shape below. branchGuard (applied at the
  // router) has already verified actorId's access to filters.branchId
  // before this runs.
  async getInventoryValueSummaryReport(filters: ReportFilters, actorId: string, actorRole: string) {
    const resolved = defaultRealtimeFilters(filters);
    const summary = await reportsRepository.getInventoryValueSummary(resolved);
    await recordAuditLog({
      action: 'REPORT_ACCESSED',
      entityType: 'report',
      entityId: 'INVENTORY_VALUE_SUMMARY',
      actorId,
      actorRole,
      branchId: resolved.branchId ?? null,
      afterState: { reportType: 'INVENTORY_VALUE_SUMMARY', filters: toWireFilters(resolved) },
    });
    return {
      generated_at: new Date().toISOString(),
      filters: toWireFilters(resolved),
      summary,
    };
  },
  // Bespoke rather than the generic realtimeReport helper — INVENTORY_SUMMARY
  // (TASK 157) returns two independently-dimensioned tables (ingredient
  // weight in kg, packaging in native count) plus their own totals, not a
  // single data[]/total pair.
  async getInventorySummaryReport(filters: ReportFilters, actorId: string, actorRole: string): Promise<InventorySummaryResponse> {
    const resolved = defaultRealtimeFilters(filters);
    const split = await reportsRepository.getInventorySummarySplit(resolved);
    const rowCount = split.ingredientWeightKg.length + split.packagingPc.length;

    await accessAudit('INVENTORY_SUMMARY', resolved, actorId, actorRole, rowCount);

    return {
      report_type: 'INVENTORY_SUMMARY',
      generated_at: new Date().toISOString(),
      filters: toWireFilters(resolved),
      ingredient_weight_kg: split.ingredientWeightKg,
      packaging_pc: split.packagingPc,
      ingredient_weight_totals_kg: split.ingredientWeightTotalsKg,
      packaging_totals_pc: split.packagingTotalsPc,
      excluded_ingredient_count: split.excludedIngredientCount,
    };
  },
  getAttendanceSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('ATTENDANCE_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getAttendanceSummary(f)),
  getFraudAlertSummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('FRAUD_ALERT_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getFraudAlertSummary(f)),
  getAuditLogReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('AUDIT_LOG', filters, actorId, actorRole, (f) => reportsRepository.getAuditLog(f)),

  getProductPerformanceReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('PRODUCT_PERFORMANCE', branchId, actorId, actorRole),
  getFlavorPerformanceReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('FLAVOR_PERFORMANCE', branchId, actorId, actorRole),
  getEmployeePerformanceReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('EMPLOYEE_PERFORMANCE', branchId, actorId, actorRole),
  getInventoryValuationReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('INVENTORY_VALUATION', branchId, actorId, actorRole),
  getBranchComparisonReport: (branchId: string | null, actorId: string, actorRole: string) =>
    precomputedReport('BRANCH_COMPARISON', branchId, actorId, actorRole),

  // Admin Inventory Valuation rollup — InventoryStock/InventoryItem/Branch-sourced,
  // org-wide. Computed fresh on every call (no snapshot cache to go stale): the admin
  // dashboard already refetches this on inventory-affecting realtime events, so a
  // snapshot layer here would only reintroduce the staleness this task removes.
  async getInventoryValuationRollupReport(actorId: string, actorRole: string) {
    const data = await reportsRepository.getInventoryValuationRollup();
    await recordAuditLog({
      action: 'REPORT_ACCESSED',
      entityType: 'report',
      entityId: 'ADMIN_INVENTORY_VALUATION_ROLLUP',
      actorId,
      actorRole,
      branchId: null,
      afterState: { reportType: 'ADMIN_INVENTORY_VALUATION_ROLLUP', branchCount: data.branches.length },
    });
    return data;
  },

  async getPaymentMethodMixReport(filters: ReportFilters, actorId: string, actorRole: string) {
    const resolved = defaultRealtimeFilters(filters);
    const data = await reportsRepository.getPaymentMethodMix(resolved);
    await recordAuditLog({
      action: 'REPORT_ACCESSED',
      entityType: 'report',
      entityId: 'PAYMENT_METHOD_MIX',
      actorId,
      actorRole,
      branchId: resolved.branchId ?? null,
      afterState: { reportType: 'PAYMENT_METHOD_MIX', filters: toWireFilters(resolved) },
    });
    return data;
  },

  async getInventoryAnalyticsReport(params: { branchId?: string; period?: '7d' | '30d' | '90d' | '1yr' }, actorId: string, actorRole: string) {
    const period = params.period ?? '30d';
    const { dateFrom, dateTo, periodDays } = inventoryAnalyticsDateRange(period);
    const data = await reportsRepository.getInventoryAnalytics({ branchId: params.branchId, dateFrom, dateTo, periodDays });
    await recordAuditLog({
      action: 'REPORT_ACCESSED',
      entityType: 'report',
      entityId: 'INVENTORY_ANALYTICS',
      actorId,
      actorRole,
      branchId: params.branchId ?? null,
      afterState: { reportType: 'INVENTORY_ANALYTICS', period, branchId: params.branchId ?? null },
    });
    return data;
  },

  async requestExport(
    reportType: ReportType,
    filters: ReportFilters,
    format: 'csv' | 'pdf',
    requesterId: string,
    requesterRole: string,
    branchId: string | null,
  ): Promise<ExportResult> {
    if (SUPER_ADMIN_ONLY_TYPES.has(reportType) && requesterRole !== ROLES.SUPER_ADMIN) {
      throw new ReportError('FORBIDDEN_REPORT_TYPE', `${reportType} can only be exported by a super admin`, 403);
    }

    // The Supervisor/Branch Reports page exports one row per record, never the
    // aggregates Admin's reports export, so its files can match its tables. Those
    // all stop at a fixed row limit and say so, whatever the request's own limit.
    if (requesterRole !== ROLES.SUPER_ADMIN) {
      const plan = boundedExportPlan(reportType, filters, requesterRole);
      if (plan) return runBoundedExport(reportType, defaultRealtimeFilters(filters), format, requesterId, requesterRole, branchId, plan);
    }

    // EXPENSES has no ReportSnapshot-backed data source. POS-PERF-P60 — both
    // formats come from the query behind the ledger's own totals, with the type
    // filter, stopping at the record-level row limits and saying so inside the
    // file. A browser-built CSV only ever held the page on screen. Redirected
    // regardless of role, same as INVENTORY_SUMMARY below: non-super-admin branch access was
    // already enforced by the /export route's inline hasBranchAccess check
    // before reaching this function, so branchIds: 'all' here only means
    // "don't re-restrict a branch that access control already validated."
    if (reportType === 'EXPENSES') {
      // No default window: no dates means every date, as on the ledger whose totals this file must match.
      const resolvedFilters = filters;
      const rowLimit = SYNC_ROW_LIMIT[format];
      const expenseFilters: ExpenseFilters = {
        branchIds: 'all',
        branch_id: resolvedFilters.branchId,
        expense_type_id: resolvedFilters.expenseTypeId,
        category: resolvedFilters.expenseCategory,
        unassigned: resolvedFilters.expenseUnassigned,
        dateFrom: resolvedFilters.dateFrom ? manilaDateKey(resolvedFilters.dateFrom) : undefined,
        dateTo: resolvedFilters.dateTo ? manilaDateKey(resolvedFilters.dateTo) : undefined,
        page: 1,
        limit: rowLimit,
      };
      const { expenses, total, totalAmount } = await expensesRepository.findAll(expenseFilters);
      const rows: ExpensesExportRow[] = expenses.map((row) => ({
        incurred_at: row.incurredAt.toISOString(),
        branch: row.branch.name,
        expense_type: expenseDisplayName({ expense_type_id: row.expenseTypeId, expense_type_name: row.expenseTypeName, category: row.category }),
        current_type_name: row.expenseType && row.expenseType.name !== row.expenseTypeName ? row.expenseType.name : '',
        vendor_name: row.vendorName ?? '',
        // A CSV keeps the number, for spreadsheets: see generateCsv.
        amount: format === 'csv' ? row.amount.toNumber() : formatPhp(row.amount.toNumber()),
        created_by_name: `${row.creator.firstName} ${row.creator.lastName}`,
        proof_available: row.receiptKey ? 'Yes' : 'No',
      }));
      const coverage = expensesExportCoverage(
        expenses.map((row) => ({ amount: row.amount.toNumber(), incurred_at: row.incurredAt.toISOString() })),
        total > expenses.length,
      );
      const filename = buildExportFilename(reportType, format, resolvedFilters, { partial: coverage.partial });
      let buffer: Buffer;
      if (format === 'csv') {
        buffer = generateCsv(rows, EXPENSES_EXPORT_COLUMNS, coverage.partial ? `${coverage.note} All ${total} matching expenses total ${formatPhp(totalAmount)}.` : undefined);
      } else {
        const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
        buffer = await generateExpensesPdf(resolvedFilters, rows, total, totalAmount, branch?.name ?? null, 'POTATO CORNER', coverage.partial ? coverage.note : undefined);
      }

      await recordAuditLog({
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: reportType,
        actorId: requesterId,
        actorRole: requesterRole,
        branchId,
        afterState: { reportType, format, async: false, rowCount: rows.length, partial: coverage.partial },
      });
      return { kind: 'file', buffer, filename, contentType: format === 'csv' ? 'text/csv' : 'application/pdf' };
    }

    // INVENTORY_SUMMARY (TASK 157) renders as two independently-dimensioned
    // tables (ingredient weight in kg, packaging in native count), which the
    // generic single-totals-row generateCsv/generatePdf can't express, so
    // both formats are redirected to the dedicated builders regardless of
    // role (the underlying data is identical for every requester).
    if (reportType === 'INVENTORY_SUMMARY') {
      const resolvedFilters = defaultRealtimeFilters(filters);
      const split = await reportsRepository.getInventorySummarySplit(resolvedFilters);
      const filename = buildExportFilename(reportType, format, resolvedFilters);
      const rowCount = split.ingredientWeightKg.length + split.packagingPc.length;

      let buffer: Buffer;
      let contentType: 'text/csv' | 'application/pdf';
      if (format === 'csv') {
        buffer = generateInventorySummaryCsv(split);
        contentType = 'text/csv';
      } else {
        const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
        buffer = await generateInventorySummaryPdf(resolvedFilters, split, branch?.name ?? null);
        contentType = 'application/pdf';
      }

      await recordAuditLog({
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: reportType,
        actorId: requesterId,
        actorRole: requesterRole,
        branchId,
        afterState: { reportType, format, async: false, rowCount },
      });
      return { kind: 'file', buffer, filename, contentType };
    }

    const resolvedFilters = PRECOMPUTED_TYPES.has(reportType) ? precomputedWindowFilters(branchId) : defaultRealtimeFilters(filters);
    const count = await reportsRepository.countRows(reportType, resolvedFilters);

    if (count < ASYNC_EXPORT_THRESHOLD[format]) {
      const rows = await getReportRows(reportType, { ...resolvedFilters, page: 1, limit: count || 1 });
      const columns = REPORT_COLUMNS[reportType];
      const filename = buildExportFilename(reportType, format, resolvedFilters);

      let buffer: Buffer;
      let contentType: 'text/csv' | 'application/pdf';
      if (format === 'csv') {
        buffer = generateCsv(rows, columns);
        contentType = 'text/csv';
      } else {
        const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
        buffer = await generatePdf(reportType, resolvedFilters, rows, columns, branch?.name ?? null);
        contentType = 'application/pdf';
      }

      await recordAuditLog({
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: reportType,
        actorId: requesterId,
        actorRole: requesterRole,
        branchId,
        afterState: { reportType, format, async: false, rowCount: rows.length },
      });
      return { kind: 'file', buffer, filename, contentType };
    }

    // POS-PERF-P59 — every row: with the request's own limit, a paginated report's job silently wrote just that page.
    const job = await enqueueGenerateExport({ reportType, filters: { ...resolvedFilters, page: 1, limit: count }, format, requesterId, branchId });
    await recordAuditLog({
      action: 'REPORT_EXPORTED',
      entityType: 'report',
      entityId: reportType,
      actorId: requesterId,
      actorRole: requesterRole,
      branchId,
      afterState: { reportType, format, async: true, jobId: job.id, rowCount: count },
    });
    return {
      kind: 'job',
      job_id: job.id ?? '',
      message: "Export queued — you'll be notified when it's ready",
      estimated_seconds: count < 1000 ? 10 : count < 10_000 ? 30 : 120,
    };
  },
};
