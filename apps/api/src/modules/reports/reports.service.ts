import type { ReportType } from '@potato-corner/shared';
import { reportsRepository } from './reports.repository.js';
import type { ReportFilters, ReportResponse } from './reports.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

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
};
