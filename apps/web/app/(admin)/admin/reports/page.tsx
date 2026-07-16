'use client';

import { useEffect, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import type {
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
  ExportReadyPayload,
  ExportRequestInput,
} from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';
import {
  useDailySalesReport,
  useShiftSummaryReport,
  useCashReconciliationReport,
  useVoidRefundReport,
  useDiscountComplianceReport,
  useInventoryMovementReport,
  useAttendanceSummaryReport,
  useFraudAlertSummaryReport,
  useProductPerformanceReport,
  useFlavorPerformanceReport,
  useEmployeePerformanceReport,
  useInventoryValuationReport,
  useBranchComparisonReport,
  useRequestExport,
  useReportsRealtimeSync,
} from '@/hooks/queries/use-reports';

const REFRESH_COOLDOWN_SECONDS = 60;
const DEFAULT_RANGE_DAYS = 7;

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoDateString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const dailySalesColumns: ColumnDef<DailySalesReportRow>[] = [
  { accessorKey: 'report_date', header: 'Date' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'discount_total', header: 'Discounts', cell: ({ row }) => formatCurrency(row.original.discount_total) },
  { accessorKey: 'net_sales', header: 'Net Sales', cell: ({ row }) => formatCurrency(row.original.net_sales) },
  { accessorKey: 'completed_count', header: 'Completed' },
  { accessorKey: 'voided_count', header: 'Voided' },
  { accessorKey: 'refunded_count', header: 'Refunded' },
];

const shiftSummaryColumns: ColumnDef<ShiftSummaryReportRow>[] = [
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'started_at', header: 'Started', cell: ({ row }) => formatDateTime(row.original.started_at) },
  { accessorKey: 'closed_at', header: 'Closed', cell: ({ row }) => (row.original.closed_at ? formatDateTime(row.original.closed_at) : '—') },
  { accessorKey: 'cash_sales_total', header: 'Cash Sales', cell: ({ row }) => formatCurrency(row.original.cash_sales_total) },
  { accessorKey: 'gcash_sales_total', header: 'GCash Sales', cell: ({ row }) => formatCurrency(row.original.gcash_sales_total) },
  { accessorKey: 'total_transaction_count', header: 'Transactions' },
];

const cashReconciliationColumns: ColumnDef<CashReconciliationReportRow>[] = [
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'opening_counted_total', header: 'Opening', cell: ({ row }) => formatCurrency(row.original.opening_counted_total) },
  {
    accessorKey: 'closing_counted_total',
    header: 'Closing',
    cell: ({ row }) => (row.original.closing_counted_total !== null ? formatCurrency(row.original.closing_counted_total) : '—'),
  },
  {
    accessorKey: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => (row.original.cash_variance !== null ? formatCurrency(row.original.cash_variance) : '—'),
  },
  {
    accessorKey: 'variance_approved',
    header: 'Approved',
    cell: ({ row }) => (row.original.variance_approved === null ? '—' : row.original.variance_approved ? 'Yes' : 'No'),
  },
];

const voidRefundColumns: ColumnDef<VoidRefundReportRow>[] = [
  { accessorKey: 'transaction_number', header: 'Receipt #' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'total_amount', header: 'Amount', cell: ({ row }) => formatCurrency(row.original.total_amount) },
  { accessorKey: 'reason', header: 'Reason', cell: ({ row }) => row.original.reason ?? '—' },
  { accessorKey: 'actioned_by_name', header: 'Actioned By', cell: ({ row }) => row.original.actioned_by_name ?? '—' },
];

const discountComplianceColumns: ColumnDef<DiscountComplianceReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'discount_type', header: 'Discount Type' },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'total_discount_amount', header: 'Total Discount', cell: ({ row }) => formatCurrency(row.original.total_discount_amount) },
];

const inventoryMovementColumns: ColumnDef<InventoryMovementReportRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'movement_type', header: 'Type' },
  { accessorKey: 'quantity_change', header: 'Change' },
  { accessorKey: 'quantity_after', header: 'Balance After' },
  { accessorKey: 'recorded_by_name', header: 'Recorded By', cell: ({ row }) => row.original.recorded_by_name ?? '—' },
  { accessorKey: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const attendanceSummaryColumns: ColumnDef<AttendanceSummaryReportRow>[] = [
  { accessorKey: 'employee_name', header: 'Employee' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'clock_in', header: 'Clock In', cell: ({ row }) => formatDateTime(row.original.clock_in) },
  { accessorKey: 'clock_out', header: 'Clock Out', cell: ({ row }) => (row.original.clock_out ? formatDateTime(row.original.clock_out) : '—') },
  { accessorKey: 'actual_work_minutes', header: 'Minutes Worked', cell: ({ row }) => row.original.actual_work_minutes ?? '—' },
  { accessorKey: 'status', header: 'Status' },
];

const fraudAlertSummaryColumns: ColumnDef<FraudAlertSummaryReportRow>[] = [
  { accessorKey: 'alert_type', header: 'Type' },
  { accessorKey: 'severity', header: 'Severity' },
  { accessorKey: 'branch_name', header: 'Branch', cell: ({ row }) => row.original.branch_name ?? 'All Branches' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'created_at', header: 'Created', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const productPerformanceColumns: ColumnDef<ProductPerformanceReportRow>[] = [
  { accessorKey: 'product_name', header: 'Product' },
  { accessorKey: 'variant_name', header: 'Variant' },
  { accessorKey: 'units_sold', header: 'Units Sold' },
  { accessorKey: 'gross_revenue', header: 'Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

const flavorPerformanceColumns: ColumnDef<FlavorPerformanceReportRow>[] = [
  { accessorKey: 'flavor_name', header: 'Flavor' },
  { accessorKey: 'units_sold', header: 'Units Sold' },
  { accessorKey: 'gross_revenue', header: 'Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

const employeePerformanceColumns: ColumnDef<EmployeePerformanceReportRow>[] = [
  { accessorKey: 'employee_name', header: 'Employee' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'hours_worked', header: 'Hours Worked' },
];

const inventoryValuationColumns: ColumnDef<InventoryValuationReportRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { accessorKey: 'unit', header: 'Unit' },
  { accessorKey: 'current_stock', header: 'Current Stock' },
  { accessorKey: 'unit_cost', header: 'Unit Cost', cell: ({ row }) => (row.original.unit_cost !== null ? formatCurrency(row.original.unit_cost) : '—') },
  { accessorKey: 'total_value', header: 'Total Value', cell: ({ row }) => formatCurrency(row.original.total_value) },
  { accessorKey: 'status', header: 'Status' },
];

const branchComparisonColumns: ColumnDef<BranchComparisonReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  { accessorKey: 'active_shift_count', header: 'Active Shifts' },
  { accessorKey: 'low_stock_ingredient_count', header: 'Low Stock Items' },
];

export default function AdminReportsPage() {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSocketConnected = useSocketStore((s) => s.isConnected);

  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => todayDateString());
  const [activeTab, setActiveTab] = useState('DAILY_SALES');
  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const requestExport = useRequestExport();

  useReportsRealtimeSync((payload: ExportReadyPayload) => {
    if (payload.requester_id !== currentUserId) return;
    toast.success('Export ready', {
      description: `Your ${payload.report_type} export is ready`,
      action: { label: 'Download', onClick: () => window.open(payload.download_url, '_blank') },
      duration: 30_000,
    });
    setIsExporting(false);
  });

  useEffect(() => {
    if (!refreshDisabled) return;
    if (refreshCooldown <= 0) {
      setRefreshDisabled(false);
      return;
    }
    const timer = setInterval(() => setRefreshCooldown((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshDisabled, refreshCooldown]);

  const realtimeFilters = { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 };

  const dailySales = useDailySalesReport(realtimeFilters, activeTab === 'DAILY_SALES');
  const shiftSummary = useShiftSummaryReport(realtimeFilters, activeTab === 'SHIFT_SUMMARY');
  const cashReconciliation = useCashReconciliationReport(realtimeFilters, activeTab === 'CASH_RECONCILIATION');
  const voidRefund = useVoidRefundReport(realtimeFilters, activeTab === 'VOID_REFUND');
  const discountCompliance = useDiscountComplianceReport(realtimeFilters, activeTab === 'DISCOUNT_COMPLIANCE');
  const inventoryMovement = useInventoryMovementReport(realtimeFilters, activeTab === 'INVENTORY_MOVEMENT');
  const attendanceSummary = useAttendanceSummaryReport(realtimeFilters, activeTab === 'ATTENDANCE_SUMMARY');
  const fraudAlertSummary = useFraudAlertSummaryReport(realtimeFilters, activeTab === 'FRAUD_ALERT_SUMMARY');
  const productPerformance = useProductPerformanceReport(selectedBranchId ?? undefined, activeTab === 'PRODUCT_PERFORMANCE');
  const flavorPerformance = useFlavorPerformanceReport(selectedBranchId ?? undefined, activeTab === 'FLAVOR_PERFORMANCE');
  const employeePerformance = useEmployeePerformanceReport(selectedBranchId ?? undefined, activeTab === 'EMPLOYEE_PERFORMANCE');
  const inventoryValuation = useInventoryValuationReport(selectedBranchId ?? undefined, activeTab === 'INVENTORY_VALUATION');
  const branchComparison = useBranchComparisonReport(selectedBranchId ?? undefined, activeTab === 'BRANCH_COMPARISON');

  const activeQueryByTab: Record<string, { refetch: () => void }> = {
    DAILY_SALES: dailySales,
    SHIFT_SUMMARY: shiftSummary,
    CASH_RECONCILIATION: cashReconciliation,
    VOID_REFUND: voidRefund,
    DISCOUNT_COMPLIANCE: discountCompliance,
    INVENTORY_MOVEMENT: inventoryMovement,
    ATTENDANCE_SUMMARY: attendanceSummary,
    FRAUD_ALERT_SUMMARY: fraudAlertSummary,
    PRODUCT_PERFORMANCE: productPerformance,
    FLAVOR_PERFORMANCE: flavorPerformance,
    EMPLOYEE_PERFORMANCE: employeePerformance,
    INVENTORY_VALUATION: inventoryValuation,
    BRANCH_COMPARISON: branchComparison,
  };

  function handleRefresh() {
    activeQueryByTab[activeTab]?.refetch();
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    setIsExporting(true);
    const input: ExportRequestInput = {
      report_type: activeTab as ExportRequestInput['report_type'],
      filters: { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 },
      format,
    };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-muted-foreground text-sm">Real-time and pre-computed reporting across all branches.</p>
        </div>
        <span
          className={`h-2 w-2 rounded-full ${isSocketConnected ? 'bg-green-500' : 'bg-red-500'}`}
          title={isSocketConnected ? 'Connected' : 'Disconnected'}
        />
      </div>

      <ReportFilterBar
        branchId={selectedBranchId}
        onBranchChange={setSelectedBranchId}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        onRefresh={handleRefresh}
        onExportCsv={() => handleExport('csv')}
        onExportPdf={() => handleExport('pdf')}
        isRefreshDisabled={refreshDisabled}
        refreshCooldownSeconds={refreshCooldown}
        isExporting={isExporting}
        showBranchSelector
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="DAILY_SALES">Daily Sales</TabsTrigger>
          <TabsTrigger value="SHIFT_SUMMARY">Shift Summary</TabsTrigger>
          <TabsTrigger value="CASH_RECONCILIATION">Cash Reconciliation</TabsTrigger>
          <TabsTrigger value="VOID_REFUND">Void/Refund</TabsTrigger>
          <TabsTrigger value="DISCOUNT_COMPLIANCE">Discount Compliance</TabsTrigger>
          <TabsTrigger value="INVENTORY_MOVEMENT">Inventory Movement</TabsTrigger>
          <TabsTrigger value="ATTENDANCE_SUMMARY">Attendance Summary</TabsTrigger>
          <TabsTrigger value="FRAUD_ALERT_SUMMARY">Fraud Alert Summary</TabsTrigger>
          <TabsTrigger value="PRODUCT_PERFORMANCE">Product Performance</TabsTrigger>
          <TabsTrigger value="FLAVOR_PERFORMANCE">Flavor Performance</TabsTrigger>
          <TabsTrigger value="EMPLOYEE_PERFORMANCE">Employee Performance</TabsTrigger>
          <TabsTrigger value="INVENTORY_VALUATION">Inventory Valuation</TabsTrigger>
          <TabsTrigger value="BRANCH_COMPARISON">Branch Comparison</TabsTrigger>
        </TabsList>

        <TabsContent value="DAILY_SALES">
          <ReportLastUpdated timestamp={dailySales.data?.generated_at} isLoading={dailySales.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Gross Sales" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={dailySales.isLoading} />
            <KpiCard title="Completed" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.completed_count, 0)} isLoading={dailySales.isLoading} />
            <KpiCard title="Voided" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.voided_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
            <KpiCard title="Refunded" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.refunded_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
          </div>
          <DataTable columns={dailySalesColumns} data={dailySales.data?.data ?? []} isLoading={dailySales.isLoading} emptyState={<EmptyState title="No sales in this range" />} />
        </TabsContent>

        <TabsContent value="SHIFT_SUMMARY">
          <ReportLastUpdated timestamp={shiftSummary.data?.generated_at} isLoading={shiftSummary.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Shifts" value={(shiftSummary.data?.data ?? []).length} isLoading={shiftSummary.isLoading} />
            <KpiCard title="Cash Sales" value={(shiftSummary.data?.data ?? []).reduce((sum, r) => sum + r.cash_sales_total, 0)} isLoading={shiftSummary.isLoading} />
            <KpiCard title="GCash Sales" value={(shiftSummary.data?.data ?? []).reduce((sum, r) => sum + r.gcash_sales_total, 0)} isLoading={shiftSummary.isLoading} />
          </div>
          <DataTable columns={shiftSummaryColumns} data={shiftSummary.data?.data ?? []} isLoading={shiftSummary.isLoading} emptyState={<EmptyState title="No shifts in this range" />} />
        </TabsContent>

        <TabsContent value="CASH_RECONCILIATION">
          <ReportLastUpdated timestamp={cashReconciliation.data?.generated_at} isLoading={cashReconciliation.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Closed/Flagged Shifts" value={(cashReconciliation.data?.data ?? []).length} isLoading={cashReconciliation.isLoading} />
            <KpiCard
              title="Flagged"
              value={(cashReconciliation.data?.data ?? []).filter((r) => r.status === 'flagged').length}
              isLoading={cashReconciliation.isLoading}
              tone="danger"
            />
            <KpiCard
              title="Unapproved Variance"
              value={(cashReconciliation.data?.data ?? []).filter((r) => r.cash_variance !== null && r.cash_variance !== 0 && !r.variance_approved).length}
              isLoading={cashReconciliation.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={cashReconciliationColumns}
            data={cashReconciliation.data?.data ?? []}
            isLoading={cashReconciliation.isLoading}
            emptyState={<EmptyState title="No closed or flagged shifts in this range" />}
          />
        </TabsContent>

        <TabsContent value="VOID_REFUND">
          <ReportLastUpdated timestamp={voidRefund.data?.generated_at} isLoading={voidRefund.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Voided" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'voided').length} isLoading={voidRefund.isLoading} />
            <KpiCard title="Refunded" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'refunded').length} isLoading={voidRefund.isLoading} />
            <KpiCard title="Total Amount" value={(voidRefund.data?.data ?? []).reduce((sum, r) => sum + r.total_amount, 0)} isLoading={voidRefund.isLoading} tone="warning" />
          </div>
          <DataTable columns={voidRefundColumns} data={voidRefund.data?.data ?? []} isLoading={voidRefund.isLoading} emptyState={<EmptyState title="No voids or refunds in this range" />} />
        </TabsContent>

        <TabsContent value="DISCOUNT_COMPLIANCE">
          <ReportLastUpdated timestamp={discountCompliance.data?.generated_at} isLoading={discountCompliance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Discounted Transactions" value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.transaction_count, 0)} isLoading={discountCompliance.isLoading} />
            <KpiCard title="Total Discount" value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.total_discount_amount, 0)} isLoading={discountCompliance.isLoading} />
          </div>
          <DataTable
            columns={discountComplianceColumns}
            data={discountCompliance.data?.data ?? []}
            isLoading={discountCompliance.isLoading}
            emptyState={<EmptyState title="No discounted transactions in this range" />}
          />
        </TabsContent>

        <TabsContent value="INVENTORY_MOVEMENT">
          <ReportLastUpdated timestamp={inventoryMovement.data?.generated_at} isLoading={inventoryMovement.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Movements" value={(inventoryMovement.data?.data ?? []).length} isLoading={inventoryMovement.isLoading} />
            <KpiCard
              title="Waste Events"
              value={(inventoryMovement.data?.data ?? []).filter((r) => r.movement_type === 'waste').length}
              isLoading={inventoryMovement.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={inventoryMovementColumns}
            data={inventoryMovement.data?.data ?? []}
            isLoading={inventoryMovement.isLoading}
            emptyState={<EmptyState title="No inventory movements in this range" />}
          />
        </TabsContent>

        <TabsContent value="ATTENDANCE_SUMMARY">
          <ReportLastUpdated timestamp={attendanceSummary.data?.generated_at} isLoading={attendanceSummary.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Records" value={(attendanceSummary.data?.data ?? []).length} isLoading={attendanceSummary.isLoading} />
            <KpiCard
              title="Total Overtime Minutes"
              value={(attendanceSummary.data?.data ?? []).reduce((sum, r) => sum + r.overtime_minutes, 0)}
              isLoading={attendanceSummary.isLoading}
            />
          </div>
          <DataTable
            columns={attendanceSummaryColumns}
            data={attendanceSummary.data?.data ?? []}
            isLoading={attendanceSummary.isLoading}
            emptyState={<EmptyState title="No attendance records in this range" />}
          />
        </TabsContent>

        <TabsContent value="FRAUD_ALERT_SUMMARY">
          <ReportLastUpdated timestamp={fraudAlertSummary.data?.generated_at} isLoading={fraudAlertSummary.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Alerts" value={(fraudAlertSummary.data?.data ?? []).length} isLoading={fraudAlertSummary.isLoading} />
            <KpiCard
              title="Critical/High"
              value={(fraudAlertSummary.data?.data ?? []).filter((r) => r.severity === 'critical' || r.severity === 'high').length}
              isLoading={fraudAlertSummary.isLoading}
              tone="danger"
            />
          </div>
          <DataTable
            columns={fraudAlertSummaryColumns}
            data={fraudAlertSummary.data?.data ?? []}
            isLoading={fraudAlertSummary.isLoading}
            emptyState={<EmptyState title="No fraud alerts in this range" />}
          />
        </TabsContent>

        <TabsContent value="PRODUCT_PERFORMANCE">
          <ReportLastUpdated timestamp={productPerformance.data?.computed_at} isLoading={productPerformance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Products" value={(productPerformance.data?.data ?? []).length} isLoading={productPerformance.isLoading} />
            <KpiCard title="Total Revenue" value={(productPerformance.data?.data ?? []).reduce((sum, r) => sum + r.gross_revenue, 0)} isLoading={productPerformance.isLoading} />
          </div>
          <DataTable
            columns={productPerformanceColumns}
            data={productPerformance.data?.data ?? []}
            isLoading={productPerformance.isLoading}
            emptyState={<EmptyState title="No product sales in the last 30 days" />}
          />
        </TabsContent>

        <TabsContent value="FLAVOR_PERFORMANCE">
          <ReportLastUpdated timestamp={flavorPerformance.data?.computed_at} isLoading={flavorPerformance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Flavors" value={(flavorPerformance.data?.data ?? []).length} isLoading={flavorPerformance.isLoading} />
            <KpiCard title="Total Revenue" value={(flavorPerformance.data?.data ?? []).reduce((sum, r) => sum + r.gross_revenue, 0)} isLoading={flavorPerformance.isLoading} />
          </div>
          <DataTable
            columns={flavorPerformanceColumns}
            data={flavorPerformance.data?.data ?? []}
            isLoading={flavorPerformance.isLoading}
            emptyState={<EmptyState title="No flavor sales in the last 30 days" />}
          />
        </TabsContent>

        <TabsContent value="EMPLOYEE_PERFORMANCE">
          <ReportLastUpdated timestamp={employeePerformance.data?.computed_at} isLoading={employeePerformance.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Employees" value={(employeePerformance.data?.data ?? []).length} isLoading={employeePerformance.isLoading} />
            <KpiCard title="Total Sales" value={(employeePerformance.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={employeePerformance.isLoading} />
          </div>
          <DataTable
            columns={employeePerformanceColumns}
            data={employeePerformance.data?.data ?? []}
            isLoading={employeePerformance.isLoading}
            emptyState={<EmptyState title="No employee sales in the last 30 days" />}
          />
        </TabsContent>

        <TabsContent value="INVENTORY_VALUATION">
          <ReportLastUpdated timestamp={inventoryValuation.data?.computed_at} isLoading={inventoryValuation.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Ingredients" value={(inventoryValuation.data?.data ?? []).length} isLoading={inventoryValuation.isLoading} />
            <KpiCard title="Total Value" value={(inventoryValuation.data?.data ?? []).reduce((sum, r) => sum + r.total_value, 0)} isLoading={inventoryValuation.isLoading} />
            <KpiCard
              title="Low/Critical"
              value={(inventoryValuation.data?.data ?? []).filter((r) => r.status !== 'ok').length}
              isLoading={inventoryValuation.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={inventoryValuationColumns}
            data={inventoryValuation.data?.data ?? []}
            isLoading={inventoryValuation.isLoading}
            emptyState={<EmptyState title="No ingredients found" />}
          />
        </TabsContent>

        <TabsContent value="BRANCH_COMPARISON">
          <ReportLastUpdated timestamp={branchComparison.data?.computed_at} isLoading={branchComparison.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Branches" value={(branchComparison.data?.data ?? []).length} isLoading={branchComparison.isLoading} />
            <KpiCard title="Total Sales" value={(branchComparison.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={branchComparison.isLoading} />
            <KpiCard title="Active Shifts" value={(branchComparison.data?.data ?? []).reduce((sum, r) => sum + r.active_shift_count, 0)} isLoading={branchComparison.isLoading} />
          </div>
          <DataTable
            columns={branchComparisonColumns}
            data={branchComparison.data?.data ?? []}
            isLoading={branchComparison.isLoading}
            emptyState={<EmptyState title="No branch data available" />}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
