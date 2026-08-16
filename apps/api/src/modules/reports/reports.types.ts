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
  InventoryValueSummary,
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
  // Sold Product Transactions export-parity fields (Task 209.10) — only
  // getDailySalesTransactions reads these; every other report/repository
  // method ignores them, same as an absent branchId/dateFrom today.
  cashierId?: string;
  paymentMethod?: 'cash' | 'gcash' | 'maya' | 'other';
  status?: 'completed' | 'voided' | 'refunded';
  search?: string;
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
  // Task 209.xx — the configured percentage actually applied at sale time
  // (Transaction.discountRateUsed), frozen forever; never today's Discount
  // Settings value. Null for no-discount rows and for legacy sales predating
  // this column.
  discount_rate_used?: number | null;
  created_at: string;
  cashier_name: string;
  // Task 209.5 — carried on every row for reuse by the Discount Compliance
  // CSV/PDF export (see DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS in
  // reports.columns.ts). Not part of DAILY_SALES_TRANSACTION_COLUMNS, so the
  // Daily Sales tab's own export is unaffected by these fields' presence.
  transaction_id: string;
  branch_name: string;
  discount_proof_available: 'Yes' | 'No';
  // Task: Discount Compliance CSV/PDF parity — decrypted discountCustomerId
  // (same field the Admin drilldown shows), null for no-discount rows, rows
  // with no stored reference, and legacy rows that fail to decrypt.
  discount_id_reference?: string | null;
} & Record<string, unknown>;
