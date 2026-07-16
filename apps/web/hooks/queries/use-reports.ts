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
  type InventoryMovementReportRow,
  type AttendanceSummaryReportRow,
  type FraudAlertSummaryReportRow,
  type ProductPerformanceReportRow,
  type FlavorPerformanceReportRow,
  type EmployeePerformanceReportRow,
  type InventoryValuationReportRow,
  type BranchComparisonReportRow,
} from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useSocket } from '@/hooks/use-socket';

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
export function useInventoryMovementReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<InventoryMovementReportRow>('INVENTORY_MOVEMENT', filters, enabled && Boolean(filters.branch_id));
}
export function useAttendanceSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<AttendanceSummaryReportRow>('ATTENDANCE_SUMMARY', filters, enabled && Boolean(filters.branch_id));
}
/** Admin-only report — no branch_id required, so `enabled` is not gated on it. */
export function useFraudAlertSummaryReport(filters: ReportQueryFilters, enabled = true) {
  return useRealtimeReport<FraudAlertSummaryReportRow>('FRAUD_ALERT_SUMMARY', filters, enabled);
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

interface ExportResult {
  download_url?: string;
  expires_at?: string;
  job_id?: string;
  message?: string;
  estimated_seconds?: number;
}

export function useRequestExport() {
  return useMutation({
    mutationFn: async (input: ExportRequestInput) => {
      const response = await apiClient<ExportResult>('/api/reports/export', { method: 'POST', body: JSON.stringify(input) });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to request report export'));
      return response.data;
    },
    onSuccess: (data) => {
      if (data.download_url) {
        toast.success('Export ready', { description: 'Your download link is ready.' });
      } else {
        toast.success("Generating your report… you'll be notified when it's ready");
      }
    },
    onError: (error: Error) => toast.error(error.message),
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
