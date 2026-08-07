// apps/api/src/modules/reports/reports.columns.ts
import { reportsRepository } from './reports.repository.js';
import type { ReportColumn, ReportFilters, DailySalesTransactionRow } from './reports.types.js';
import type { ReportType } from '@potato-corner/shared';

/**
 * Not part of REPORT_COLUMNS below — used only by reports.service.ts's
 * DAILY_SALES PDF special-case for the Supervisor/Branch Reports page's
 * Daily Sales tab. See DailySalesTransactionRow's doc comment.
 */
export const DAILY_SALES_TRANSACTION_COLUMNS: ReportColumn<DailySalesTransactionRow>[] = [
  { key: 'receipt_number', header: 'Receipt #' },
  { key: 'payment_method', header: 'Payment' },
  { key: 'total_amount', header: 'Total' },
  { key: 'vat_amount', header: 'VAT' },
  { key: 'discount_amount', header: 'Discount' },
  { key: 'discount_type', header: 'Discount Type' },
  { key: 'created_at', header: 'Date' },
  { key: 'cashier_name', header: 'Cashier' },
];

/**
 * Task 209.5 — Discount Compliance's own column set for the Supervisor/
 * Branch CSV/PDF export (see reports.service.ts's DISCOUNT_COMPLIANCE
 * redirect branch), sourced from the same getDailySalesTransactions rows as
 * DAILY_SALES_TRANSACTION_COLUMNS above but never sharing that array — this
 * keeps the Daily Sales tab's own export exactly as it was before this
 * task. discount_proof_available is Yes/No only: never the storage key, a
 * signed URL, or the image itself (see requestExport's export policy).
 */
export const DISCOUNT_COMPLIANCE_TRANSACTION_COLUMNS: ReportColumn<DailySalesTransactionRow>[] = [
  { key: 'receipt_number', header: 'Receipt #' },
  { key: 'created_at', header: 'Date/Time' },
  { key: 'branch_name', header: 'Branch' },
  { key: 'cashier_name', header: 'Cashier' },
  { key: 'discount_type', header: 'Discount Type' },
  { key: 'discount_amount', header: 'Discount Amount' },
  { key: 'discount_proof_available', header: 'Proof Available' },
];

export const REPORT_COLUMNS: Record<ReportType, ReportColumn<Record<string, unknown>>[]> = {
  DAILY_SALES: [
    { key: 'report_date', header: 'Date' },
    { key: 'branch_id', header: 'Branch ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'gross_sales', header: 'Gross Sales' },
    { key: 'discount_total', header: 'Discounts' },
    { key: 'vat_total', header: 'VAT' },
    { key: 'net_sales', header: 'Net Sales' },
    { key: 'completed_count', header: 'Completed' },
    { key: 'voided_count', header: 'Voided' },
    { key: 'refunded_count', header: 'Refunded' },
  ],
  SHIFT_SUMMARY: [
    { key: 'shift_id', header: 'Shift ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'status', header: 'Status' },
    { key: 'started_at', header: 'Started At' },
    { key: 'closed_at', header: 'Closed At' },
    { key: 'opening_cash_amount', header: 'Opening Cash' },
    { key: 'closing_cash_amount', header: 'Closing Cash' },
    { key: 'expected_closing_cash', header: 'Expected Closing' },
    { key: 'cash_variance', header: 'Variance' },
    { key: 'cash_sales_total', header: 'Cash Sales' },
    { key: 'gcash_sales_total', header: 'GCash Sales' },
    { key: 'total_transaction_count', header: 'Transactions' },
    { key: 'voided_count', header: 'Voided' },
    { key: 'refunded_count', header: 'Refunded' },
    { key: 'total_discount_amount', header: 'Discounts' },
    { key: 'pwd_sc_transaction_count', header: 'PWD/SC Txns' },
  ],
  CASH_RECONCILIATION: [
    { key: 'shift_id', header: 'Shift ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'status', header: 'Status' },
    { key: 'opening_counted_total', header: 'Opening Counted' },
    { key: 'closing_counted_total', header: 'Closing Counted' },
    { key: 'expected_closing_cash', header: 'Expected Closing' },
    { key: 'cash_variance', header: 'Variance' },
    { key: 'variance_approved', header: 'Variance Approved' },
    { key: 'variance_explanation', header: 'Explanation' },
  ],
  VOID_REFUND: [
    { key: 'transaction_id', header: 'Transaction ID', isAudit: true },
    { key: 'transaction_number', header: 'Receipt #' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'cashier_name', header: 'Cashier' },
    { key: 'status', header: 'Status' },
    { key: 'total_amount', header: 'Amount' },
    { key: 'reason', header: 'Reason' },
    { key: 'actioned_by_name', header: 'Actioned By' },
    { key: 'actioned_at', header: 'Actioned At' },
  ],
  DISCOUNT_COMPLIANCE: [
    { key: 'branch_name', header: 'Branch' },
    { key: 'discount_type', header: 'Discount Type' },
    { key: 'transaction_count', header: 'Transactions' },
    { key: 'total_discount_amount', header: 'Total Discount' },
    { key: 'total_vat_exempt_amount', header: 'VAT Exempt Total' },
  ],
  INVENTORY_MOVEMENT: [
    { key: 'movement_id', header: 'Movement ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'ingredient_name', header: 'Ingredient' },
    { key: 'unit', header: 'Unit' },
    { key: 'movement_type', header: 'Type' },
    { key: 'quantity_change', header: 'Change' },
    { key: 'quantity_before', header: 'Before' },
    { key: 'quantity_after', header: 'After' },
    { key: 'recorded_by_name', header: 'Recorded By' },
    { key: 'created_at', header: 'Date' },
    // isAudit: CSV-only (see generateCsv/generatePdf's shared visibleColumns
    // filter) — these three exist on the Inventory Movement screen's table
    // but not the PDF layout, so they're appended as audit columns rather
    // than visible ones to keep the PDF's rendered columns unchanged.
    { key: 'reference_type', header: 'Reference Type', isAudit: true },
    { key: 'reference_id', header: 'Reference ID', isAudit: true },
    { key: 'notes', header: 'Notes', isAudit: true },
  ],
  INVENTORY_CONSUMPTION_SUMMARY: [
    { key: 'ingredient_id', header: 'Ingredient ID', isAudit: true },
    { key: 'ingredient_name', header: 'Ingredient' },
    { key: 'branch_id', header: 'Branch ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'unit', header: 'Unit' },
    { key: 'quantity_consumed', header: 'Quantity Consumed' },
    { key: 'unit_cost', header: 'Unit Cost' },
    { key: 'consumption_value', header: 'Consumption Value' },
    { key: 'movement_count', header: 'Sales Movements' },
  ],
  // Not used for CSV/PDF export — INVENTORY_SUMMARY is special-cased in
  // reports.service.ts's requestExport and report.queue.ts's
  // processGenerateExport (see generateInventorySummaryCsv/Pdf), since it
  // renders as a single native-unit table (Task 144) rather than the
  // generic single-totals-row layout. This entry exists only so
  // REPORT_COLUMNS stays a total Record<ReportType, ...>.
  INVENTORY_SUMMARY: [
    { key: 'ingredient_id', header: 'Ingredient ID', isAudit: true },
    { key: 'ingredient_name', header: 'Ingredient' },
    { key: 'branch_id', header: 'Branch ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'unit', header: 'Unit' },
    { key: 'opening_stock', header: 'Opening Stock' },
    { key: 'consumed_today', header: 'Consumed Today' },
    { key: 'consumed_this_month', header: 'Consumed This Month' },
    { key: 'remaining_stock', header: 'Remaining' },
  ],
  ATTENDANCE_SUMMARY: [
    { key: 'employee_id', header: 'Employee ID', isAudit: true },
    { key: 'employee_name', header: 'Employee' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'clock_in', header: 'Clock In' },
    { key: 'clock_out', header: 'Clock Out' },
    { key: 'actual_work_minutes', header: 'Minutes Worked' },
    { key: 'overtime_minutes', header: 'Overtime Minutes' },
    { key: 'break_minutes', header: 'Break Minutes' },
    { key: 'status', header: 'Status' },
  ],
  FRAUD_ALERT_SUMMARY: [
    { key: 'alert_id', header: 'Alert ID', isAudit: true },
    { key: 'alert_type', header: 'Type' },
    { key: 'severity', header: 'Severity' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'status', header: 'Status' },
    { key: 'created_at', header: 'Created At' },
    { key: 'updated_at', header: 'Updated At' },
  ],
  PRODUCT_PERFORMANCE: [
    { key: 'product_variant_id', header: 'Variant ID', isAudit: true },
    { key: 'product_name', header: 'Product' },
    { key: 'variant_name', header: 'Variant' },
    { key: 'units_sold', header: 'Units Sold' },
    { key: 'gross_revenue', header: 'Revenue' },
    { key: 'transaction_count', header: 'Transactions' },
  ],
  FLAVOR_PERFORMANCE: [
    { key: 'flavor_id', header: 'Flavor ID', isAudit: true },
    { key: 'flavor_name', header: 'Flavor' },
    { key: 'units_sold', header: 'Units Sold' },
    { key: 'gross_revenue', header: 'Revenue' },
  ],
  EMPLOYEE_PERFORMANCE: [
    { key: 'employee_id', header: 'Employee ID', isAudit: true },
    { key: 'employee_name', header: 'Employee' },
    { key: 'branch_name', header: 'Branch' },
    { key: 'transaction_count', header: 'Transactions' },
    { key: 'gross_sales', header: 'Gross Sales' },
    { key: 'hours_worked', header: 'Hours Worked' },
  ],
  INVENTORY_VALUATION: [
    { key: 'ingredient_id', header: 'Ingredient ID', isAudit: true },
    { key: 'ingredient_name', header: 'Ingredient' },
    { key: 'unit', header: 'Unit' },
    { key: 'current_stock', header: 'Current Stock' },
    { key: 'unit_cost', header: 'Unit Cost' },
    { key: 'total_value', header: 'Total Value' },
    { key: 'status', header: 'Status' },
  ],
  BRANCH_COMPARISON: [
    { key: 'branch_id', header: 'Branch ID', isAudit: true },
    { key: 'branch_name', header: 'Branch' },
    { key: 'gross_sales', header: 'Gross Sales' },
    { key: 'transaction_count', header: 'Transactions' },
    { key: 'active_shift_count', header: 'Active Shifts' },
    { key: 'low_stock_ingredient_count', header: 'Low Stock Items' },
  ],
  AUDIT_LOG: [
    { key: 'created_at', header: 'Timestamp' },
    { key: 'actor_id', header: 'Actor ID', isAudit: true },
    { key: 'actor_role', header: 'Role' },
    { key: 'action', header: 'Action' },
    { key: 'ip_address', header: 'IP Address', isAudit: true },
  ],
};

export async function getReportRows(reportType: ReportType, filters: ReportFilters): Promise<Record<string, unknown>[]> {
  switch (reportType) {
    case 'DAILY_SALES':
      return reportsRepository.getDailySales(filters);
    case 'SHIFT_SUMMARY':
      return reportsRepository.getShiftSummary(filters);
    case 'CASH_RECONCILIATION':
      return reportsRepository.getCashReconciliation(filters);
    case 'VOID_REFUND':
      return reportsRepository.getVoidRefund(filters);
    case 'DISCOUNT_COMPLIANCE':
      return reportsRepository.getDiscountCompliance(filters);
    case 'INVENTORY_MOVEMENT':
      return reportsRepository.getInventoryMovement(filters);
    case 'INVENTORY_CONSUMPTION_SUMMARY':
      return reportsRepository.getInventoryConsumptionSummary(filters);
    // INVENTORY_SUMMARY has no flat-row shape (TASK 157 split it into two
    // tables) — it's special-cased in reports.service.ts's requestExport and
    // report.queue.ts's processGenerateExport instead of going through this
    // generic per-row/per-column path.
    case 'INVENTORY_SUMMARY':
      return [];
    case 'ATTENDANCE_SUMMARY':
      return reportsRepository.getAttendanceSummary(filters);
    case 'FRAUD_ALERT_SUMMARY':
      return reportsRepository.getFraudAlertSummary(filters);
    case 'PRODUCT_PERFORMANCE':
      return reportsRepository.getProductPerformance(filters);
    case 'FLAVOR_PERFORMANCE':
      return reportsRepository.getFlavorPerformance(filters);
    case 'EMPLOYEE_PERFORMANCE':
      return reportsRepository.getEmployeePerformance(filters);
    case 'INVENTORY_VALUATION':
      return reportsRepository.getInventoryValuation(filters);
    case 'BRANCH_COMPARISON':
      return reportsRepository.getBranchComparison(filters);
    case 'AUDIT_LOG':
      return reportsRepository.getAuditLog(filters);
    default:
      return [];
  }
}
