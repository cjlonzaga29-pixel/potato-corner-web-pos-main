import { ROLES } from '@potato-corner/shared';
import type { ReportType } from '@potato-corner/shared';
import { reportsRepository } from './reports.repository.js';
import type { ReportFilters, ReportResponse, SnapshotResponse } from './reports.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getReportRows, REPORT_COLUMNS } from './reports.columns.js';
import { ReportError } from './reports.types.js';
import { generateCsv } from '../../lib/reports/csv.js';
import { supabaseAdmin } from '../../lib/supabase.js';
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

async function precomputedReport<T>(
  reportType: ReportType,
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

const SYNC_CSV_ROW_LIMIT = 10_000;
const SUPER_ADMIN_ONLY_TYPES = new Set<ReportType>(['FRAUD_ALERT_SUMMARY', 'BRANCH_COMPARISON', 'AUDIT_LOG']);
const PRECOMPUTED_TYPES = new Set<ReportType>(['PRODUCT_PERFORMANCE', 'FLAVOR_PERFORMANCE', 'EMPLOYEE_PERFORMANCE', 'INVENTORY_VALUATION', 'BRANCH_COMPARISON']);

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
  ): Promise<{ download_url: string; expires_at: string } | { job_id: string; message: string; estimated_seconds: number }> {
    if (SUPER_ADMIN_ONLY_TYPES.has(reportType) && requesterRole !== ROLES.SUPER_ADMIN) {
      throw new ReportError('FORBIDDEN_REPORT_TYPE', `${reportType} can only be exported by a super admin`, 403);
    }

    const resolvedFilters = PRECOMPUTED_TYPES.has(reportType) ? precomputedWindowFilters(branchId) : defaultRealtimeFilters(filters);
    const count = await reportsRepository.countRows(reportType, resolvedFilters);

    if (format === 'csv' && count < SYNC_CSV_ROW_LIMIT) {
      const rows = await getReportRows(reportType, { ...resolvedFilters, page: 1, limit: count || 1 });
      const columns = REPORT_COLUMNS[reportType];
      const buffer = generateCsv(rows, columns);
      const path = `reports/${requesterId}/${Date.now()}-${reportType}.csv`;

      const { error: uploadError } = await supabaseAdmin.storage.from('report-exports').upload(path, buffer, { contentType: 'text/csv', upsert: false });
      if (uploadError) throw new ReportError('EXPORT_UPLOAD_FAILED', 'Failed to upload the report export', 502);

      const { data: signed, error: signError } = await supabaseAdmin.storage.from('report-exports').createSignedUrl(path, 86_400);
      if (signError || !signed) throw new ReportError('EXPORT_SIGN_FAILED', 'Failed to create a download link for the export', 502);

      const expiresAt = new Date(Date.now() + 86_400 * 1000).toISOString();
      await recordAuditLog({
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: reportType,
        actorId: requesterId,
        actorRole: requesterRole,
        branchId,
        afterState: { reportType, format, path, async: false, rowCount: rows.length },
      });
      return { download_url: signed.signedUrl, expires_at: expiresAt };
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
      job_id: job.id ?? '',
      message: "Export queued — you'll be notified when it's ready",
      estimated_seconds: count < 1000 ? 10 : count < 10_000 ? 30 : 120,
    };
  },
};
