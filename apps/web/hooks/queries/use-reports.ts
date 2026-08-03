'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SOCKET_EVENTS,
  type ReportType,
  type ReportResponse,
  type SnapshotResponse,
  type ExportRequestInput,
  type ExportReadyPayload,
  type DailySalesReportRow,
  type ShiftSummaryReportRow,
  type CashReconciliationReportRow,
  type VoidRefundReportRow,
  type DiscountComplianceReportRow,
  type PaymentMethodMixReportRow,
  type InventoryMovementReportRow,
  type InventoryConsumptionSummaryReportRow,
  type InventorySummaryResponse,
  type AttendanceSummaryReportRow,
  type FraudAlertSummaryReportRow,
  type ProductPerformanceReportRow,
  type FlavorPerformanceReportRow,
  type EmployeePerformanceReportRow,
  type InventoryValuationReportRow,
  type BranchComparisonReportRow,
  type InventoryAnalyticsReport,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { requestReportExport, type ExportOutcome } from '@/lib/report-export-client';
import { triggerBrowserDownload } from '@/lib/trigger-download';
import { useSocket } from '@/hooks/use-socket';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}
function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

export interface ReportQueryFilters {
  branch_id?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

function buildReportQueryString(filters: ReportQueryFilters): string {
  const params = new URLSearchParams();
  if (filters.branch_id) params.set('branch_id', filters.branch_id);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  params.set('page', String(filters.page ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  return params.toString();
}

const REALTIME_ENDPOINTS: Record<string, string> = {
  DAILY_SALES: 'daily-sales',
  SHIFT_SUMMARY: 'shift-summary',
  CASH_RECONCILIATION: 'cash-reconciliation',
  VOID_REFUND: 'void-refund',
  DISCOUNT_COMPLIANCE: 'discount-compliance',
  INVENTORY_MOVEMENT: 'inventory-movement',
  INVENTORY_CONSUMPTION_SUMMARY: 'inventory-consumption-summary',
  ATTENDANCE_SUMMARY: 'attendance-summary',
  FRAUD_ALERT_SUMMARY: 'fraud-alert-summary',
};

function useRealtimeReport<T>(reportType: ReportType, filters: ReportQueryFilters, enabled: boolean) {
  const endpoint = REALTIME_ENDPOINTS[reportType];
  return useQuery({
    queryKey: ['reports', reportType, filters],
    queryFn: async () => {
      const response = await apiClient<ReportResponse<T>>(`/api/reports/${endpoint}?${buildReportQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, `Failed to load ${reportType} report`));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useDailySalesReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<DailySalesReportRow>('DAILY_SALES', filters, enabled && Boolean(filters.branch_id));
}
/**
 * Same endpoint as useDailySalesReport, without its branch_id requirement —
 * the Reports tab treats DAILY_SALES as branch-scoped-only by product
 * decision, but the dashboard's org-wide "All my branches" view needs the
 * admin-only unscoped variant the backend already supports (branchGuard
 * allows an admin to omit branch_id).
 */
export function useDashboardSalesTrendReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<DailySalesReportRow>('DAILY_SALES', filters, enabled);
}
export function useShiftSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<ShiftSummaryReportRow>('SHIFT_SUMMARY', filters, enabled && Boolean(filters.branch_id));
}
export function useCashReconciliationReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<CashReconciliationReportRow>('CASH_RECONCILIATION', filters, enabled && Boolean(filters.branch_id));
}
export function useVoidRefundReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<VoidRefundReportRow>('VOID_REFUND', filters, enabled && Boolean(filters.branch_id));
}
export function useDiscountComplianceReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<DiscountComplianceReportRow>('DISCOUNT_COMPLIANCE', filters, enabled && Boolean(filters.branch_id));
}
/** Same endpoint as useDiscountComplianceReport, without its branch_id requirement — see useDashboardSalesTrendReport for why. */
export function useDashboardDiscountMixReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<DiscountComplianceReportRow>('DISCOUNT_COMPLIANCE', filters, enabled);
}
export function useInventoryMovementReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<InventoryMovementReportRow>('INVENTORY_MOVEMENT', filters, enabled && Boolean(filters.branch_id));
}
export function useInventoryConsumptionSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<InventoryConsumptionSummaryReportRow>('INVENTORY_CONSUMPTION_SUMMARY', filters, enabled && Boolean(filters.branch_id));
}
/**
 * GET /api/reports/inventory-summary returns a bespoke two-table response
 * (TASK 157: split ingredient-weight-KG and packaging-PC breakdowns, each
 * with its own totals) rather than the generic ReportResponse<T>.data[]
 * shape, so it's fetched directly rather than through useRealtimeReport,
 * the same pattern as usePaymentMethodMixReport below.
 */
export function useInventorySummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'INVENTORY_SUMMARY', filters],
    queryFn: async () => {
      const response = await apiClient<InventorySummaryResponse>(`/api/reports/inventory-summary?${buildReportQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load INVENTORY_SUMMARY report'));
      return response.data;
    },
    enabled: enabled && Boolean(filters.branch_id),
    staleTime: 60_000,
  });
}
export function useAttendanceSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<AttendanceSummaryReportRow>('ATTENDANCE_SUMMARY', filters, enabled && Boolean(filters.branch_id));
}
/** Admin-only report — no branch_id required, so `enabled` is not gated on it. */
export function useFraudAlertSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<FraudAlertSummaryReportRow>('FRAUD_ALERT_SUMMARY', filters, enabled);
}

/**
 * GET /api/reports/payment-method-mix — not a registered ReportType (no CSV
 * export/snapshot support), so it's fetched directly rather than through
 * useRealtimeReport, mirroring useInventoryAnalytics. Org-wide when
 * filters.branch_id is omitted, so `enabled` is not gated on it.
 */
export function usePaymentMethodMixReport(filters: ReportQueryFilters, enabled = true) {
  return useQuery({
    queryKey: ['reports', 'PAYMENT_METHOD_MIX', filters],
    queryFn: async () => {
      const response = await apiClient<PaymentMethodMixReportRow[]>(`/api/reports/payment-method-mix?${buildReportQueryString(filters)}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load payment method mix report'));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}

/**
 * GET /api/reports/inventory-analytics — not a registered ReportType (no
 * CSV export/snapshot support), so it's fetched directly rather than
 * through useRealtimeReport, same as usePaymentMethodMixReport. Branch-
 * scoped when branchId is given; org-wide (super_admin only) when omitted.
 */
export function useInventoryAnalytics(branchId: string | undefined, period: '7d' | '30d' | '90d' | '1yr' = '30d', enabled = true) {
  return useQuery({
    queryKey: ['reports', 'INVENTORY_ANALYTICS', branchId ?? null, period],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (branchId) params.set('branch_id', branchId);
      const response = await apiClient<InventoryAnalyticsReport>(`/api/reports/inventory-analytics?${params.toString()}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load inventory analytics'));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}

const PRECOMPUTED_ENDPOINTS: Record<string, string> = {
  PRODUCT_PERFORMANCE: 'product-performance',
  FLAVOR_PERFORMANCE: 'flavor-performance',
  EMPLOYEE_PERFORMANCE: 'employee-performance',
  INVENTORY_VALUATION: 'inventory-valuation',
  BRANCH_COMPARISON: 'branch-comparison',
};

function usePrecomputedReport<T>(reportType: ReportType, branchId: string | undefined, enabled: boolean) {
  const endpoint = PRECOMPUTED_ENDPOINTS[reportType];
  return useQuery({
    queryKey: ['reports', reportType, branchId ?? null],
    queryFn: async () => {
      const qs = branchId ? `?branch_id=${branchId}` : '';
      const response = await apiClient<SnapshotResponse<T>>(`/api/reports/${endpoint}${qs}`);
      if (!response.data) throw new Error(errorMessage(response, `Failed to load ${reportType} report`));
      return response.data;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useProductPerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<ProductPerformanceReportRow>('PRODUCT_PERFORMANCE', branchId, enabled && Boolean(branchId));
}
/**
 * Same endpoint as useProductPerformanceReport, without its branch_id
 * requirement — the backend already supports an admin omitting branch_id
 * for an org-wide snapshot (precomputedReport(reportType, null, ...), same
 * mechanism BRANCH_COMPARISON uses), the Reports tab just never exercises
 * that path. The dashboard's org-wide "All my branches" view does.
 */
export function useDashboardProductPerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<ProductPerformanceReportRow>('PRODUCT_PERFORMANCE', branchId, enabled);
}
export function useFlavorPerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<FlavorPerformanceReportRow>('FLAVOR_PERFORMANCE', branchId, enabled && Boolean(branchId));
}
export function useEmployeePerformanceReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<EmployeePerformanceReportRow>('EMPLOYEE_PERFORMANCE', branchId, enabled && Boolean(branchId));
}
export function useInventoryValuationReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<InventoryValuationReportRow>('INVENTORY_VALUATION', branchId, enabled && Boolean(branchId));
}
/** Admin-only report — no branch_id required, so `enabled` is not gated on it. */
export function useBranchComparisonReport(branchId: string | undefined, enabled = true) {
  return usePrecomputedReport<BranchComparisonReportRow>('BRANCH_COMPARISON', branchId, enabled);
}

function formatLabel(format: ExportRequestInput['format']): string {
  return format.toUpperCase();
}

/**
 * POST /api/reports/export now returns one of two genuinely different
 * shapes (see report-export-client.ts): raw file bytes for the common case
 * (both csv and pdf, most of the time), or a JSON job descriptor for the
 * rare oversized-report case that finishes asynchronously via
 * useReportsRealtimeSync below. requestReportExport() tells them apart by
 * Content-Type rather than this hook ever touching response.json() itself.
 */
export function useRequestExport() {
  return useMutation({
    mutationFn: (input: ExportRequestInput): Promise<ExportOutcome> => requestReportExport(input),
    onSuccess: (outcome: ExportOutcome, variables: ExportRequestInput) => {
      if (outcome.kind === 'file') {
        // Trigger the actual browser download before announcing success —
        // a toast that fires first and a download that silently fails
        // would tell the user something happened when nothing did.
        triggerBrowserDownload(outcome.file.blob, outcome.file.filename);
        toast.success(`${formatLabel(variables.format)} downloaded`);
      } else {
        toast.success(outcome.message || "Generating your report… you'll be notified when it's ready");
      }
    },
    onError: (error: Error, variables: ExportRequestInput) => {
      toast.error(`${formatLabel(variables.format)} export failed`, {
        description: error.message,
      });
    },
  });
}

/**
 * useRealtimeInvalidate only invalidates query keys — it has no payload
 * callback, and the export-ready toast needs `download_url` from the
 * payload. Subscribes directly via useSocket()'s on/off instead (the
 * spec's documented fallback) rather than modifying use-socket.ts.
 */
export function useReportsRealtimeSync(onExportReady?: (payload: ExportReadyPayload) => void): void {
  const { on, off } = useSocket();
  const queryClient = useQueryClient();

  useEffect(() => {
    function handleReady(...args: unknown[]) {
      const payload = args[0] as ExportReadyPayload;
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onExportReady?.(payload);
    }
    function handleFailed() {
      toast.error('Report export failed — please try again');
    }
    on(SOCKET_EVENTS.REPORT_EXPORT_READY, handleReady);
    on(SOCKET_EVENTS.REPORT_EXPORT_FAILED, handleFailed);
    return () => {
      off(SOCKET_EVENTS.REPORT_EXPORT_READY, handleReady);
      off(SOCKET_EVENTS.REPORT_EXPORT_FAILED, handleFailed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, onExportReady]);
}

/**
 * Keeps dashboard trend/mix charts fresh off the same transaction events the
 * "Live Activity" feed already reacts to — thin useRealtimeInvalidate
 * wrapper, same convention as useTransactionsRealtimeSync et al. Distinct
 * from useReportsRealtimeSync above, which handles export-ready/failed
 * toasts, not chart data.
 */
export function useReportsTrendsRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.TRANSACTION_COMPLETED, SOCKET_EVENTS.TRANSACTION_REFUNDED, SOCKET_EVENTS.VOID_REQUESTED],
    [
      ['reports', 'DAILY_SALES'],
      ['reports', 'BRANCH_COMPARISON'],
      ['reports', 'PRODUCT_PERFORMANCE'],
      ['reports', 'DISCOUNT_COMPLIANCE'],
      ['reports', 'PAYMENT_METHOD_MIX'],
    ],
  );
}

/**
 * Keeps the Inventory Analytics tab/panel fresh — same event set as
 * useAdminInventoryRollupRealtimeSync (stock movements + the sale/refund/void
 * events that trigger deduction reversal), since both derive from the same
 * underlying InventoryStock/InventoryMovement writes.
 */
export function useInventoryAnalyticsRealtimeSync(): void {
  useRealtimeInvalidate(
    [
      SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED,
      SOCKET_EVENTS.INVENTORY_LOW_STOCK,
      SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK,
      SOCKET_EVENTS.TRANSACTION_COMPLETED,
      SOCKET_EVENTS.TRANSACTION_REFUNDED,
      SOCKET_EVENTS.VOID_REQUESTED,
    ],
    [['reports', 'INVENTORY_ANALYTICS'], ['reports', 'INVENTORY_CONSUMPTION_SUMMARY'], ['reports', 'INVENTORY_SUMMARY']],
  );
}
