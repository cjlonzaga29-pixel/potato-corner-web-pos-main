// apps/api/src/modules/reports/reports.types.ts
export type {
  ReportType,
  ExportRequestInput,
  ExportJobResponse,
  ExportReadyPayload,
  ExportFailedPayload,
  ReportResponse,
  SnapshotResponse,
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
} from '@potato-corner/shared';

import type { ReportType } from '@potato-corner/shared';

export class ReportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

/** Parsed, internal filter shape — dates are real Date objects, not wire strings. */
export interface ReportFilters {
  branchId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  limit: number;
}

export interface ExportRequest {
  reportType: ReportType;
  filters: ReportFilters;
  format: 'csv' | 'pdf';
}

/** Column definition shared by CSV and PDF generation (reports.columns.ts). */
export interface ReportColumn<T> {
  key: keyof T;
  header: string;
  /** Audit-only columns (e.g. raw ids) are appended after visible columns, headers prefixed with `_`. */
  isAudit?: boolean;
}
