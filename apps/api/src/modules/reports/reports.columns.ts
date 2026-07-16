// apps/api/src/modules/reports/reports.columns.ts
import { reportsRepository } from './reports.repository.js';
import type { ReportColumn, ReportFilters } from './reports.types.js';
import type { ReportType } from '@potato-corner/shared';

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
    default:
      return [];
  }
}
