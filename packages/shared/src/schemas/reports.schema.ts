// packages/shared/src/schemas/reports.schema.ts
import { z } from 'zod';
import { REPORT_TYPE, type ReportType } from '../constants/status.js';

const reportTypeValues = Object.values(REPORT_TYPE) as [ReportType, ...ReportType[]];

export const ReportFiltersSchema = z.object({
  branch_id: z.uuid().optional(),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.iso.datetime())
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ReportFiltersInput = z.infer<typeof ReportFiltersSchema>;

export const ExportRequestSchema = z.object({
  report_type: z.enum(reportTypeValues),
  filters: ReportFiltersSchema,
  format: z.enum(['csv', 'pdf']),
});
export type ExportRequestInput = z.infer<typeof ExportRequestSchema>;

export const ExportJobResponseSchema = z.object({
  job_id: z.string(),
  message: z.string(),
  estimated_seconds: z.number().int(),
});
export type ExportJobResponse = z.infer<typeof ExportJobResponseSchema>;

export const ExportReadyPayloadSchema = z.object({
  job_id: z.string(),
  report_type: z.enum(reportTypeValues),
  format: z.enum(['csv', 'pdf']),
  download_url: z.string(),
  expires_at: z.iso.datetime(),
  requester_id: z.uuid(),
});
export type ExportReadyPayload = z.infer<typeof ExportReadyPayloadSchema>;

export interface ExportFailedPayload {
  job_id: string;
  report_type: ReportType;
  error: string;
  requester_id: string;
}

// ---------- Row schemas (one per report type) ----------

export const DailySalesReportRowSchema = z.object({
  report_date: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  gross_sales: z.number(),
  discount_total: z.number(),
  vat_total: z.number(),
  net_sales: z.number(),
  completed_count: z.number().int(),
  voided_count: z.number().int(),
  refunded_count: z.number().int(),
});
export type DailySalesReportRow = z.infer<typeof DailySalesReportRowSchema>;

export const ShiftSummaryReportRowSchema = z.object({
  shift_id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  cashier_id: z.uuid(),
  cashier_name: z.string(),
  status: z.string(),
  started_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  opening_cash_amount: z.number(),
  closing_cash_amount: z.number().nullable(),
  expected_closing_cash: z.number().nullable(),
  cash_variance: z.number().nullable(),
  variance_approved: z.boolean().nullable(),
  cash_sales_total: z.number(),
  gcash_sales_total: z.number(),
  total_transaction_count: z.number().int(),
  voided_count: z.number().int(),
  refunded_count: z.number().int(),
  total_discount_amount: z.number(),
  pwd_sc_transaction_count: z.number().int(),
});
export type ShiftSummaryReportRow = z.infer<typeof ShiftSummaryReportRowSchema>;

export const CashReconciliationReportRowSchema = z.object({
  shift_id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  cashier_name: z.string(),
  status: z.string(),
  opening_counted_total: z.number(),
  closing_counted_total: z.number().nullable(),
  expected_closing_cash: z.number().nullable(),
  cash_variance: z.number().nullable(),
  variance_approved: z.boolean().nullable(),
  variance_explanation: z.string().nullable(),
});
export type CashReconciliationReportRow = z.infer<typeof CashReconciliationReportRowSchema>;

export const VoidRefundReportRowSchema = z.object({
  transaction_id: z.uuid(),
  transaction_number: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  cashier_name: z.string(),
  status: z.enum(['voided', 'refunded']),
  total_amount: z.number(),
  reason: z.string().nullable(),
  actioned_by_name: z.string().nullable(),
  actioned_at: z.iso.datetime().nullable(),
});
export type VoidRefundReportRow = z.infer<typeof VoidRefundReportRowSchema>;

export const DiscountComplianceReportRowSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  discount_type: z.string(),
  transaction_count: z.number().int(),
  total_discount_amount: z.number(),
  total_vat_exempt_amount: z.number(),
});
export type DiscountComplianceReportRow = z.infer<typeof DiscountComplianceReportRowSchema>;

export const InventoryMovementReportRowSchema = z.object({
  movement_id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  unit: z.string(),
  movement_type: z.string(),
  quantity_change: z.number(),
  quantity_before: z.number(),
  quantity_after: z.number(),
  recorded_by_name: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type InventoryMovementReportRow = z.infer<typeof InventoryMovementReportRowSchema>;

export const AttendanceSummaryReportRowSchema = z.object({
  employee_id: z.uuid(),
  employee_name: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  clock_in: z.iso.datetime(),
  clock_out: z.iso.datetime().nullable(),
  actual_work_minutes: z.number().int().nullable(),
  overtime_minutes: z.number().int(),
  break_minutes: z.number().int(),
  status: z.string(),
});
export type AttendanceSummaryReportRow = z.infer<typeof AttendanceSummaryReportRowSchema>;

export const FraudAlertSummaryReportRowSchema = z.object({
  alert_id: z.uuid(),
  alert_type: z.string(),
  severity: z.string(),
  employee_id: z.uuid().nullable(),
  branch_id: z.uuid().nullable(),
  branch_name: z.string().nullable(),
  status: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type FraudAlertSummaryReportRow = z.infer<typeof FraudAlertSummaryReportRowSchema>;

export const ProductPerformanceReportRowSchema = z.object({
  product_variant_id: z.uuid(),
  product_name: z.string(),
  variant_name: z.string(),
  units_sold: z.number().int(),
  gross_revenue: z.number(),
  transaction_count: z.number().int(),
});
export type ProductPerformanceReportRow = z.infer<typeof ProductPerformanceReportRowSchema>;

export const FlavorPerformanceReportRowSchema = z.object({
  flavor_id: z.uuid(),
  flavor_name: z.string(),
  units_sold: z.number().int(),
  gross_revenue: z.number(),
});
export type FlavorPerformanceReportRow = z.infer<typeof FlavorPerformanceReportRowSchema>;

export const EmployeePerformanceReportRowSchema = z.object({
  employee_id: z.uuid(),
  employee_name: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  transaction_count: z.number().int(),
  gross_sales: z.number(),
  hours_worked: z.number(),
});
export type EmployeePerformanceReportRow = z.infer<typeof EmployeePerformanceReportRowSchema>;

export const InventoryValuationReportRowSchema = z.object({
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  branch_id: z.uuid(),
  unit: z.string(),
  current_stock: z.number(),
  unit_cost: z.number().nullable(),
  total_value: z.number(),
  status: z.enum(['ok', 'low', 'critical']),
});
export type InventoryValuationReportRow = z.infer<typeof InventoryValuationReportRowSchema>;

export const BranchComparisonReportRowSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  gross_sales: z.number(),
  transaction_count: z.number().int(),
  active_shift_count: z.number().int(),
  low_stock_ingredient_count: z.number().int(),
});
export type BranchComparisonReportRow = z.infer<typeof BranchComparisonReportRowSchema>;

// ---------- Generic response wrappers (plain TS — not request-validated) ----------

export interface ReportResponse<T> {
  report_type: ReportType;
  generated_at: string;
  filters: { branch_id?: string; date_from?: string; date_to?: string; page: number; limit: number };
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface SnapshotResponse<T> {
  report_type: ReportType;
  computed_at: string;
  branch_id: string | null;
  data: T[];
}
