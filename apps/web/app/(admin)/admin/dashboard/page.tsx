'use client';

import { Suspense } from 'react';
import { useSocketStore } from '@/stores/socket.store';
import { useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useBranchRealtimeSync, useAllBranchStats, useBranches, type PaymentBreakdown } from '@/hooks/queries/use-branches';
import { useInventoryStockRealtimeSync } from '@/hooks/queries/use-universal-inventory';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { useDashboardSalesTrendReport, useInventoryAnalyticsRealtimeSync } from '@/hooks/queries/use-reports';
import { useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import { manilaToday, manilaMonthStart } from '@/lib/manila-date';
import { BranchSelector } from '@/components/admin/branch-selector';
import { DashboardKpiRow } from '@/components/admin/dashboard-kpi-row';
import { DashboardPaymentBreakdown } from '@/components/admin/dashboard-payment-breakdown';
import { DashboardLowStockCard } from '@/components/admin/dashboard-low-stock-card';
import { DashboardActiveBranchesCard } from '@/components/admin/dashboard-active-branches-card';
import { DashboardBranchPerformanceTable } from '@/components/admin/dashboard-branch-performance-table';
import { DashboardLowStockSummary } from '@/components/admin/dashboard-low-stock-summary';
import { DashboardRecentActivity } from '@/components/admin/dashboard-recent-activity';
import { SalesAnalyticsSection } from '@/components/shared/dashboard/sales-analytics-section';
import { WidgetErrorBoundary } from '@/components/shared/widget-error-boundary';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

function AdminDashboardPageContent() {
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);

  const { selectedBranchId } = useSelectedBranch();
  const branchFilter = selectedBranchId === 'all' ? undefined : selectedBranchId;

  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  useBranchRealtimeSync();
  useInventoryStockRealtimeSync(branchFilter);
  useInventoryAnalyticsRealtimeSync();
  useAttendanceRealtimeSync();
  useExpensesRealtimeSync();

  const { data: branchStats, isLoading: isLoadingBranchStats } = useAllBranchStats(branchFilter);
  const { data: branchList, isLoading: isLoadingBranchList } = useBranches({ limit: MAX_LIST_LIMIT });
  const monthTrend = useDashboardSalesTrendReport({
    date_from: manilaMonthStart(),
    date_to: manilaToday(),
    branch_id: branchFilter,
    page: 1,
    limit: MAX_LIST_LIMIT,
  });

  const grossSalesToday = branchStats?.reduce((sum, b) => sum + b.todayGrossSales, 0);
  const lowStockCount = branchStats?.reduce((sum, b) => sum + b.lowStockIngredientCount, 0);
  const grossSalesMonth = monthTrend.data?.data.reduce((sum, row) => sum + row.gross_sales, 0);

  const paymentBreakdown = branchStats?.reduce<PaymentBreakdown>(
    (acc, b) => ({
      cash: { total: acc.cash.total + b.paymentBreakdown.cash.total, count: acc.cash.count + b.paymentBreakdown.cash.count },
      gcash: { total: acc.gcash.total + b.paymentBreakdown.gcash.total, count: acc.gcash.count + b.paymentBreakdown.gcash.count },
      maya: { total: acc.maya.total + b.paymentBreakdown.maya.total, count: acc.maya.count + b.paymentBreakdown.maya.count },
      other: { total: acc.other.total + b.paymentBreakdown.other.total, count: acc.other.count + b.paymentBreakdown.other.count },
    }),
    { cash: { total: 0, count: 0 }, gcash: { total: 0, count: 0 }, maya: { total: 0, count: 0 }, other: { total: 0, count: 0 } },
  );

  const activeBranchCount = branchList?.branches.filter((b) => b.status === 'active').length;
  const inactiveBranchCount = branchList?.branches.filter((b) => b.status !== 'active').length;

  const connectionLabel = isReconnecting ? 'Reconnecting' : isConnected ? 'Connected' : 'Disconnected';
  const connectionColor = isReconnecting ? 'bg-warning' : isConnected ? 'bg-success' : 'bg-destructive';

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Super Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">Live overview across every branch.</p>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <BranchSelector />
          <span
            title={connectionLabel}
            aria-label={connectionLabel}
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${connectionColor}`}
          />
        </div>
      </div>

      <DashboardKpiRow
        grossSalesToday={grossSalesToday}
        grossSalesMonth={grossSalesMonth}
        isLoadingToday={isLoadingBranchStats}
        isLoadingMonth={monthTrend.isLoading}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DashboardPaymentBreakdown breakdown={paymentBreakdown} isLoading={isLoadingBranchStats} />
        <DashboardLowStockCard totalItems={lowStockCount} isLoading={isLoadingBranchStats} />
        <DashboardActiveBranchesCard
          activeCount={activeBranchCount}
          inactiveCount={inactiveBranchCount}
          isLoading={isLoadingBranchList}
        />
      </div>

      <WidgetErrorBoundary label="Sales Trend">
        <SalesAnalyticsSection branchId={branchFilter} />
      </WidgetErrorBoundary>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <WidgetErrorBoundary label="Branch Performance">
          <DashboardBranchPerformanceTable branchId={branchFilter} />
        </WidgetErrorBoundary>
        <DashboardLowStockSummary branchId={branchFilter} />
      </div>

      <DashboardRecentActivity branchId={branchFilter} />
    </div>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense fallback={<div>Loading dashboard...</div>}>
      <AdminDashboardPageContent />
    </Suspense>
  );
}
