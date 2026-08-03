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
  PaymentMethodMixReportRow,
  InventoryMovementReportRow,
  InventoryConsumptionSummaryReportRow,
  IngredientWeightKgRow,
  PackagingPcRow,
  IngredientWeightTotalsKg,
  PackagingTotalsPc,
  InventorySummaryResponse,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  ProductPerformanceReportRow,
  FlavorPerformanceReportRow,
  EmployeePerformanceReportRow,
  InventoryValuationReportRow,
  AdminInventoryValuationBranchRow,
  AdminInventoryValuationSummary,
  AdminInventoryValuationRollupResponse,
  BranchComparisonReportRow,
  InventoryAnalyticsQueryInput,
  InventoryAnalyticsReport,
  InventoryFastMover,
  InventorySlowMover,
  InventoryWasteTrendPoint,
  InventoryTurnoverByBranch,
  InventoryReorderRecommendation,
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

/**
 * One row per completed transaction — matches the Supervisor/Branch Reports
 * page's "Daily Sales" tab exactly (apps/web/components/branch-ops/reports-view.tsx's
 * getDailySalesColumns), used only for that tab's PDF export. Distinct from
 * DailySalesReportRow, which is the aggregated per-day/per-branch summary the
 * Admin Daily Sales report and DAILY_SALES CSV export use.
 */
export type DailySalesTransactionRow = {
  receipt_number: string;
  payment_method: string;
  total_amount: number;
  vat_amount: number;
  discount_amount: number;
  discount_type: string | null;
  created_at: string;
  cashier_name: string;
} & Record<string, unknown>;
