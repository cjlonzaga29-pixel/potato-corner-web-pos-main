import type { ReportType } from '@potato-corner/shared';
import { reportsRepository } from './reports.repository.js';
import type { ReportFilters, ReportResponse, SnapshotResponse } from './reports.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getReportRows } from './reports.columns.js';
import { enqueueRefreshSnapshot } from '../../queues/report.queue.js';

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

async function realtimeReport<T>(
  reportType: ReportType,
  rawFilters: ReportFilters,
  actorId: string,
  actorRole: string,
  fetchRows: (filters: ReportFilters) => Promise<T[]>,
): Promise<ReportResponse<T>> {
  const filters = defaultRealtimeFilters(rawFilters);
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
};
