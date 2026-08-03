import { ROLES } from '@potato-corner/shared';
import type { ReportType } from '@potato-corner/shared';
import type { $Enums } from '@prisma/client';
import { reportsRepository } from './reports.repository.js';
import type { ReportFilters, ReportResponse, SnapshotResponse } from './reports.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getReportRows, REPORT_COLUMNS, DAILY_SALES_TRANSACTION_COLUMNS } from './reports.columns.js';
import { ReportError } from './reports.types.js';
import { generateCsv } from '../../lib/reports/csv.js';
import { generatePdf } from '../../lib/reports/pdf.js';
import { generateInventorySummaryCsv, generateInventorySummaryPdf } from '../../lib/reports/inventory-summary-export.js';
import { buildExportFilename } from '../../lib/reports/export-filename.js';
import { prisma } from '../../lib/prisma.js';
import { enqueueGenerateExport, enqueueRefreshSnapshot } from '../../queues/report.queue.js';

const DEFAULT_REALTIME_RANGE_DAYS = 7;

function defaultRealtimeFilters(filters: ReportFilters): ReportFilters {
  if (filters.dateFrom || filters.dateTo) return filters;
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - DEFAULT_REALTIME_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { ...filters, dateFrom, dateTo };
}

function toWireFilters(filters: ReportFilters) {
  return {
    branch_id: filters.branchId,
    date_from: filters.dateFrom?.toISOString(),
    date_to: filters.dateTo?.toISOString(),
    page: filters.page,
    limit: filters.limit,
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

// Reports under this row count are generated and returned synchronously (the
// browser gets real CSV/PDF bytes in the same response, no job/notification
// round-trip). PDF's limit is far lower than CSV's — react-pdf's
// renderToBuffer is much more expensive per row than string-joining CSV
// lines, and it runs synchronously inside the request handler, so a huge PDF
// would block the event loop for other requests. Reports at or above the
// limit fall back to the existing async job + Supabase signed URL +
// Socket.io notification flow — that path is for oversized exports only, not
// the normal Export CSV/PDF buttons a user hits from the Reports page.
const SYNC_ROW_LIMIT: Record<'csv' | 'pdf', number> = { csv: 10_000, pdf: 2_000 };
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
  getInventorySummaryReport: (filters: ReportFilters, actorId: string, actorRole: string) =>
    realtimeReport('INVENTORY_SUMMARY', filters, actorId, actorRole, (f) => reportsRepository.getInventorySummary(f)),
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

    // The Supervisor/Branch Reports page's Daily Sales tab (branch-ops/
    // reports-view.tsx) exports DAILY_SALES as its report_type but renders
    // one row per completed transaction — not the aggregated per-day/branch
    // summary DAILY_SALES returns everywhere else (Admin's Daily Sales
    // report and Admin's DAILY_SALES CSV export, both unchanged below).
    // Without this branch the exported CSV/PDF rows and totals can never
    // match that screen, since they'd come from an unrelated aggregate.
    if (reportType === 'DAILY_SALES' && requesterRole !== ROLES.SUPER_ADMIN) {
      const resolvedFilters = defaultRealtimeFilters(filters);
      const rows = await reportsRepository.getDailySalesTransactions(resolvedFilters);
      const filename = buildExportFilename(reportType, format, resolvedFilters);

      let buffer: Buffer;
      let contentType: 'text/csv' | 'application/pdf';
      if (format === 'csv') {
        buffer = generateCsv(rows, DAILY_SALES_TRANSACTION_COLUMNS);
        contentType = 'text/csv';
      } else {
        const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
        buffer = await generatePdf(reportType, resolvedFilters, rows, DAILY_SALES_TRANSACTION_COLUMNS, branch?.name ?? null);
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

    // The Supervisor/Branch Reports page's Void/Refund tab (branch-ops/
    // reports-view.tsx) does not render getVoidRefund's output — it composes
    // its table (and KPI totals) from two independent status-filtered
    // transaction queries (voided, then refunded), each capped at the
    // page's own limit. getVoidRefund instead returns every matching voided
    // OR refunded row, interleaved together by date and re-sliced by
    // page/limit below — a different row set, order, and count than the
    // screen. Gated to non-super_admin: the Admin Reports page's Void/Refund
    // tab (app/(admin)/admin/reports/page.tsx) uses useVoidRefundReport,
    // which IS backed by getVoidRefund — its export already matches its
    // screen via the generic path below, so it must not be redirected here.
    // Both CSV and PDF are redirected to getVoidRefundForExport, which
    // mirrors the Supervisor/Branch screen's exact composition (voided rows
    // then refunded rows, each capped at the screen limit) so both exported
    // formats match what the screen shows.
    if (reportType === 'VOID_REFUND' && requesterRole !== ROLES.SUPER_ADMIN) {
      const resolvedFilters = defaultRealtimeFilters(filters);
      const rows = await reportsRepository.getVoidRefundForExport(resolvedFilters);
      const filename = buildExportFilename(reportType, format, resolvedFilters);
      const columns = REPORT_COLUMNS[reportType];

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

    // The Supervisor/Branch Reports page's Discount Compliance tab
    // (branch-ops/reports-view.tsx) does not render getDiscountCompliance's
    // output — it filters the same per-transaction rows the Daily Sales tab
    // uses (completedTransactions.filter(t => t.discount_type !== null)) to
    // one row per discounted transaction. getDiscountCompliance instead
    // returns a groupBy aggregate (one row per branch+discount_type with
    // summed totals) — a different grain than the screen entirely. Both CSV
    // and PDF are redirected here: reuses getDailySalesTransactions (already
    // powers the Daily Sales PDF/CSV above) and DAILY_SALES_TRANSACTION_COLUMNS,
    // filtered to discounted rows, so no new repository query, report type, or
    // column set is introduced. Gated to non-super_admin: Admin's Discount
    // Compliance CSV/PDF stay on the generic aggregate path below/unchanged.
    if (reportType === 'DISCOUNT_COMPLIANCE' && requesterRole !== ROLES.SUPER_ADMIN) {
      const resolvedFilters = defaultRealtimeFilters(filters);
      const rows = (await reportsRepository.getDailySalesTransactions(resolvedFilters)).filter((row) => row.discount_type !== null);
      const filename = buildExportFilename(reportType, format, resolvedFilters);

      let buffer: Buffer;
      let contentType: 'text/csv' | 'application/pdf';
      if (format === 'csv') {
        buffer = generateCsv(rows, DAILY_SALES_TRANSACTION_COLUMNS);
        contentType = 'text/csv';
      } else {
        const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
        buffer = await generatePdf(reportType, resolvedFilters, rows, DAILY_SALES_TRANSACTION_COLUMNS, branch?.name ?? null);
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

    // INVENTORY_SUMMARY (Task 144) renders as a single "Ingredient
    // Consumption" table with per-unit totals, which the generic
    // single-totals-row generateCsv/generatePdf can't express, so both
    // formats are redirected to the dedicated builders regardless of role
    // (the underlying rows are identical for every requester).
    if (reportType === 'INVENTORY_SUMMARY') {
      const resolvedFilters = defaultRealtimeFilters(filters);
      const rows = await reportsRepository.getInventorySummary(resolvedFilters);
      const filename = buildExportFilename(reportType, format, resolvedFilters);

      let buffer: Buffer;
      let contentType: 'text/csv' | 'application/pdf';
      if (format === 'csv') {
        buffer = generateInventorySummaryCsv(rows);
        contentType = 'text/csv';
      } else {
        const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null;
        buffer = await generateInventorySummaryPdf(resolvedFilters, rows, branch?.name ?? null);
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

    const resolvedFilters = PRECOMPUTED_TYPES.has(reportType) ? precomputedWindowFilters(branchId) : defaultRealtimeFilters(filters);
    const count = await reportsRepository.countRows(reportType, resolvedFilters);

    if (count < SYNC_ROW_LIMIT[format]) {
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

    const job = await enqueueGenerateExport({ reportType, filters: resolvedFilters, format, requesterId, branchId });
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
