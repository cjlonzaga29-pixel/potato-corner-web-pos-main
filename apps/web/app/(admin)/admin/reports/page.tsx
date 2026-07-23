'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import type {
  DailySalesReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  FraudAlertSummaryReportRow,
  ExportReadyPayload,
  ExportRequestInput,
} from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { FraudAlertManagementPanel } from '@/components/reports/fraud-alert-management-panel';
import { ShiftLogPanel } from '@/components/reports/shift-log-panel';
import { expenseColumns } from '@/components/admin/expense-columns';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';
import { useExpenses, useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import {
  useDailySalesReport,
  useCashReconciliationReport,
  useVoidRefundReport,
  useFraudAlertSummaryReport,
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

const fraudAlertSummaryColumns: ColumnDef<FraudAlertSummaryReportRow>[] = [
  { accessorKey: 'alert_type', header: 'Type' },
  { accessorKey: 'severity', header: 'Severity' },
  { accessorKey: 'branch_name', header: 'Branch', cell: ({ row }) => row.original.branch_name ?? 'All Branches' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'created_at', header: 'Created', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const VALID_TABS = new Set(['DAILY_SALES', 'CASH_RECONCILIATION', 'EXPENSES', 'VOID_REFUND', 'SHIFT_SUMMARY', 'FRAUD_ALERT_SUMMARY']);

function AdminReportsPageContent() {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSocketConnected = useSocketStore((s) => s.isConnected);
  const searchParams = useSearchParams();
  useExpensesRealtimeSync();

  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => todayDateString());
  const [activeTab, setActiveTab] = useState(() => {
    const tabParam = searchParams.get('tab');
    return tabParam && VALID_TABS.has(tabParam) ? tabParam : 'DAILY_SALES';
  });
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
  const cashReconciliation = useCashReconciliationReport(realtimeFilters, activeTab === 'CASH_RECONCILIATION');
  const voidRefund = useVoidRefundReport(realtimeFilters, activeTab === 'VOID_REFUND');
  const fraudAlertSummary = useFraudAlertSummaryReport(realtimeFilters, activeTab === 'FRAUD_ALERT_SUMMARY');
  const expenses = useExpenses({
    branch_id: selectedBranchId ?? undefined,
    date_from: dateFrom,
    date_to: dateTo,
    page: 1,
    limit: 100,
  });

  const activeQueryByTab: Record<string, { refetch: () => void }> = {
    DAILY_SALES: dailySales,
    CASH_RECONCILIATION: cashReconciliation,
    VOID_REFUND: voidRefund,
    FRAUD_ALERT_SUMMARY: fraudAlertSummary,
    EXPENSES: expenses,
  };

  function handleRefresh() {
    activeQueryByTab[activeTab]?.refetch();
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    if (activeTab === 'EXPENSES') return;
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
          <TabsTrigger value="CASH_RECONCILIATION">Cash Reconciliation</TabsTrigger>
          <TabsTrigger value="EXPENSES">Expenses</TabsTrigger>
          <TabsTrigger value="VOID_REFUND">Voided / Refund</TabsTrigger>
          <TabsTrigger value="SHIFT_SUMMARY">Shift Reports</TabsTrigger>
          <TabsTrigger value="FRAUD_ALERT_SUMMARY">Alerts</TabsTrigger>
        </TabsList>

        <TabsContent value="DAILY_SALES">
          {!selectedBranchId ? (
            <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
          ) : dailySales.isError ? <ErrorState retry={() => dailySales.refetch()} /> : <>
          <ReportLastUpdated timestamp={dailySales.data?.generated_at} isLoading={dailySales.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Gross Sales" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)} isLoading={dailySales.isLoading} />
            <KpiCard title="Completed" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.completed_count, 0)} isLoading={dailySales.isLoading} />
            <KpiCard title="Voided" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.voided_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
            <KpiCard title="Refunded" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.refunded_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
          </div>
          <DataTable columns={dailySalesColumns} data={dailySales.data?.data ?? []} isLoading={dailySales.isLoading} emptyState={<EmptyState title="No sales in this range" />} />
          </>}
        </TabsContent>

        <TabsContent value="CASH_RECONCILIATION">
          {!selectedBranchId ? (
            <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
          ) : cashReconciliation.isError ? <ErrorState retry={() => cashReconciliation.refetch()} /> : <>
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
          </>}
        </TabsContent>

        <TabsContent value="EXPENSES">
          {expenses.isError ? <ErrorState retry={() => expenses.refetch()} /> : <>
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Expenses" value={expenses.data?.total ?? 0} isLoading={expenses.isLoading} />
            <KpiCard title="Total Amount" value={expenses.data?.total_amount ?? 0} isLoading={expenses.isLoading} />
          </div>
          <DataTable
            columns={expenseColumns}
            data={expenses.data?.expenses ?? []}
            isLoading={expenses.isLoading}
            emptyState={
              <EmptyState
                title="No expenses recorded"
                description="Expenses are submitted by branch supervisors and appear here automatically."
              />
            }
          />
          </>}
        </TabsContent>

        <TabsContent value="VOID_REFUND">
          {!selectedBranchId ? (
            <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
          ) : voidRefund.isError ? <ErrorState retry={() => voidRefund.refetch()} /> : <>
          <ReportLastUpdated timestamp={voidRefund.data?.generated_at} isLoading={voidRefund.isLoading} />
          <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Voided" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'voided').length} isLoading={voidRefund.isLoading} />
            <KpiCard title="Refunded" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'refunded').length} isLoading={voidRefund.isLoading} />
            <KpiCard title="Total Amount" value={(voidRefund.data?.data ?? []).reduce((sum, r) => sum + r.total_amount, 0)} isLoading={voidRefund.isLoading} tone="warning" />
          </div>
          <DataTable columns={voidRefundColumns} data={voidRefund.data?.data ?? []} isLoading={voidRefund.isLoading} emptyState={<EmptyState title="No voids or refunds in this range" />} />
          </>}
        </TabsContent>

        <TabsContent value="SHIFT_SUMMARY">
          <ShiftLogPanel />
        </TabsContent>

        <TabsContent value="FRAUD_ALERT_SUMMARY">
          {fraudAlertSummary.isError ? <ErrorState retry={() => fraudAlertSummary.refetch()} /> : <>
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
          <div className="mt-6 border-t pt-6">
            <FraudAlertManagementPanel />
          </div>
          </>}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AdminReportsPage() {
  return (
    <Suspense fallback={<div>Loading reports...</div>}>
      <AdminReportsPageContent />
    </Suspense>
  );
}
