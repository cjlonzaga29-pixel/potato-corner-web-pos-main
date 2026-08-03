// packages/shared/src/schemas/reports.schema.ts
import { z } from 'zod';
import { REPORT_TYPE, type ReportType } from '../constants/status.js';
import { MAX_LIST_LIMIT } from '../constants/pagination.js';

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
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(25),
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
  reference_type: z.string().nullable(),
  reference_id: z.string().nullable(),
  notes: z.string().nullable(),
  recorded_by_name: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type InventoryMovementReportRow = z.infer<typeof InventoryMovementReportRowSchema>;

// Aggregated sale-driven consumption (movement_type SALE only) per ingredient/branch
// over the filtered date range — distinct from InventoryMovementReportRow above, which
// is the raw per-movement ledger across every movement type.
export const InventoryConsumptionSummaryReportRowSchema = z.object({
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  unit: z.string(),
  quantity_consumed: z.number(),
  unit_cost: z.number().nullable(),
  consumption_value: z.number(),
  movement_count: z.number().int(),
});
export type InventoryConsumptionSummaryReportRow = z.infer<typeof InventoryConsumptionSummaryReportRowSchema>;

// Per-ingredient stock snapshot: opening balance for today, consumption
// today/this-month (SALE movements only, matching the Branch Inventory
// list's "Consumed Today" column), and the current remaining balance.
// Task 144: every row displays using the inventory item's own base unit —
// no kg conversion, no CONVERSION_REQUIRED status, no section split between
// ingredients and packaging. `unit` is always the InventoryItem's base unit
// code as stored (kg, g, tbsp, tsp, pcs, ml, L, ...), never converted.
// Distinct from InventoryConsumptionSummaryReportRow above, which is a
// date-range consumption total with no stock-level or opening/remaining data.
export const InventorySummaryReportRowSchema = z.object({
  ingredient_id: z.uuid(),
  ingredient_name: z.string(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  unit: z.string(),
  opening_stock: z.number(),
  consumed_today: z.number(),
  consumed_this_month: z.number(),
  remaining_stock: z.number(),
});
export type InventorySummaryReportRow = z.infer<typeof InventorySummaryReportRowSchema>;

// TASK 149 — org-wide (or per-branch, per the same filters as the rows
// above) weight roll-up in kilograms, additive to InventorySummaryReportRow's
// native-unit rows above (never replacing them). Only non-COUNT-dimension
// items (weight/volume ingredients) ever contribute; packaging/count items
// are never included and never counted toward excluded_item_count either —
// they're simply out of scope for a weight total. excluded_item_count is
// non-COUNT items with no resolvable conversion to kg (native rows for those
// items still render — this only drops their KG contribution).
export const WeightSummaryKgSchema = z.object({
  opening_stock_kg: z.number(),
  consumed_today_kg: z.number(),
  consumed_this_month_kg: z.number(),
  remaining_kg: z.number(),
  included_item_count: z.number().int(),
  excluded_item_count: z.number().int(),
});
export type WeightSummaryKg = z.infer<typeof WeightSummaryKgSchema>;

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

// Admin Inventory Valuation rollup (InventoryItem/InventoryStock-sourced, org-wide across
// all branches) -- distinct from InventoryValuationReportRow above, which stays
// Ingredient-sourced for the existing branch-analytics tab and CSV/PDF export.
export const AdminInventoryValuationBranchRowSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  inventory_item_count: z.number().int(),
  total_inventory_value: z.number(),
  low_stock_count: z.number().int(),
  critical_stock_count: z.number().int(),
  out_of_stock_count: z.number().int(),
  last_movement_at: z.iso.datetime().nullable(),
});
export type AdminInventoryValuationBranchRow = z.infer<typeof AdminInventoryValuationBranchRowSchema>;

export const AdminInventoryValuationSummarySchema = z.object({
  total_inventory_value: z.number(),
  total_active_inventory_items: z.number().int(),
  total_inventory_stock_rows: z.number().int(),
  total_low_stock_rows: z.number().int(),
  total_critical_stock_rows: z.number().int(),
  total_out_of_stock_rows: z.number().int(),
});
export type AdminInventoryValuationSummary = z.infer<typeof AdminInventoryValuationSummarySchema>;

export const AdminInventoryValuationRollupResponseSchema = z.object({
  generated_at: z.iso.datetime(),
  branches: z.array(AdminInventoryValuationBranchRowSchema),
  summary: AdminInventoryValuationSummarySchema,
});
export type AdminInventoryValuationRollupResponse = z.infer<typeof AdminInventoryValuationRollupResponseSchema>;

export const PaymentMethodMixReportRowSchema = z.object({
  payment_method: z.string(),
  transaction_count: z.number().int(),
  total_amount: z.number(),
});
export type PaymentMethodMixReportRow = z.infer<typeof PaymentMethodMixReportRowSchema>;

export const BranchComparisonReportRowSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  gross_sales: z.number(),
  transaction_count: z.number().int(),
  active_shift_count: z.number().int(),
  low_stock_ingredient_count: z.number().int(),
});
export type BranchComparisonReportRow = z.infer<typeof BranchComparisonReportRowSchema>;

// ---------- Inventory Analytics (Step 10) ----------

export const InventoryAnalyticsQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  period: z.enum(['7d', '30d', '90d', '1yr']).default('30d'),
});
export type InventoryAnalyticsQueryInput = z.infer<typeof InventoryAnalyticsQuerySchema>;

export const InventoryFastMoverSchema = z.object({
  ingredient_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  total_consumed: z.number(),
  avg_daily_consumption: z.number(),
});
export type InventoryFastMover = z.infer<typeof InventoryFastMoverSchema>;

export const InventorySlowMoverSchema = z.object({
  ingredient_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  total_consumed: z.number(),
  days_since_last_movement: z.number().int().nullable(),
});
export type InventorySlowMover = z.infer<typeof InventorySlowMoverSchema>;

export const InventoryWasteTrendPointSchema = z.object({
  date: z.string(),
  total_waste_quantity: z.number(),
  total_waste_cost: z.number(),
});
export type InventoryWasteTrendPoint = z.infer<typeof InventoryWasteTrendPointSchema>;

export const InventoryTurnoverByBranchSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  turnover_rate: z.number(),
  total_consumed: z.number(),
  avg_inventory_value: z.number(),
});
export type InventoryTurnoverByBranch = z.infer<typeof InventoryTurnoverByBranchSchema>;

export const InventoryReorderRecommendationSchema = z.object({
  ingredient_id: z.uuid(),
  name: z.string(),
  current_stock: z.number(),
  avg_daily_consumption: z.number(),
  days_until_stockout: z.number().nullable(),
  recommended_reorder_qty: z.number(),
});
export type InventoryReorderRecommendation = z.infer<typeof InventoryReorderRecommendationSchema>;

export const InventoryAnalyticsReportSchema = z.object({
  fast_movers: z.array(InventoryFastMoverSchema),
  slow_movers: z.array(InventorySlowMoverSchema),
  waste_trends: z.array(InventoryWasteTrendPointSchema),
  turnover_by_branch: z.array(InventoryTurnoverByBranchSchema),
  reorder_recommendations: z.array(InventoryReorderRecommendationSchema),
  summary: z.object({
    total_movements: z.number().int(),
    total_waste_cost: z.number(),
    total_consumption_cost: z.number(),
    avg_turnover_rate: z.number(),
  }),
});
export type InventoryAnalyticsReport = z.infer<typeof InventoryAnalyticsReportSchema>;

// ---------- Generic response wrappers (plain TS — not request-validated) ----------

export interface ReportResponse<T> {
  report_type: ReportType;
  generated_at: string;
  filters: { branch_id?: string; date_from?: string; date_to?: string; page: number; limit: number };
  data: T[];
  total: number;
  page: number;
  limit: number;
  // Only populated for INVENTORY_SUMMARY — every other report type leaves this undefined.
  weight_summary_kg?: WeightSummaryKg;
}

export interface SnapshotResponse<T> {
  report_type: ReportType;
  computed_at: string;
  branch_id: string | null;
  data: T[];
}
