'use client';

import { Suspense } from 'react';
import { useSocketStore } from '@/stores/socket.store';
import { useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useBranchRealtimeSync, useAllBranchStats, useBranches, type PaymentBreakdown } from '@/hooks/queries/use-branches';
import { useInventoryStockRealtimeSync } from '@/hooks/queries/use-universal-inventory';
import { useAdminInventoryRollup, useAdminInventoryRollupRealtimeSync } from '@/hooks/queries/use-admin-inventory-rollup';
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
import { DashboardPageHeader, DashboardConnectionBadge } from '@/components/shared/dashboard/dashboard-page-header';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { TrendingDown, Users, PackageSearch, BellRing } from 'lucide-react';
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
  useAdminInventoryRollupRealtimeSync();

  const { data: branchStats, isLoading: isLoadingBranchStats } = useAllBranchStats(branchFilter);
  const { data: branchList, isLoading: isLoadingBranchList } = useBranches({ limit: MAX_LIST_LIMIT });
  const { data: inventoryRollup, isLoading: isLoadingInventoryRollup } = useAdminInventoryRollup();
  const monthTrend = useDashboardSalesTrendReport({
    date_from: manilaMonthStart(),
    date_to: manilaToday(),
    branch_id: branchFilter,
    page: 1,
    limit: MAX_LIST_LIMIT,
  });

  const grossSalesToday = branchStats?.reduce((sum, b) => sum + b.todayGrossSales, 0);
  const transactionsToday = branchStats?.reduce((sum, b) => sum + b.todayTransactionCount, 0);
  const averageOrderValue = grossSalesToday && transactionsToday ? grossSalesToday / transactionsToday : 0;
  const todayExpenses = branchStats?.reduce((sum, b) => sum + b.todayExpenses, 0);
  const staffClockedIn = branchStats?.reduce((sum, b) => sum + b.staffTimedInCount, 0);
  const lowStockCount = branchStats?.reduce((sum, b) => sum + b.lowStockIngredientCount, 0);
  const grossSalesMonth = monthTrend.data?.data.reduce((sum, row) => sum + row.gross_sales, 0);

  // Inventory Alerts (critical + out-of-stock) — org-wide rollup (TASK 165),
  // scoped to the selected branch client-side since the rollup endpoint has
  // no branch_id filter of its own; each branch row already carries its own
  // critical_stock_count/out_of_stock_count.
  const rollupBranches = inventoryRollup?.branches ?? [];
  const scopedRollupBranches = branchFilter ? rollupBranches.filter((b) => b.branch_id === branchFilter) : rollupBranches;
  const criticalStockCount = scopedRollupBranches.reduce((sum, b) => sum + b.critical_stock_count, 0);
  const outOfStockCount = scopedRollupBranches.reduce((sum, b) => sum + b.out_of_stock_count, 0);
  const inventoryAlertCount = criticalStockCount + outOfStockCount;

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

  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader
        title="Super Admin Dashboard"
        subtitle="Live overview across every branch."
        actions={
          <>
            <BranchSelector />
            <DashboardConnectionBadge isConnected={isConnected} isReconnecting={isReconnecting} />
          </>
        }
      />

      <DashboardKpiRow
        grossSalesToday={grossSalesToday}
        grossSalesMonth={grossSalesMonth}
        transactionsToday={transactionsToday}
        averageOrderValue={averageOrderValue}
        isLoading={isLoadingBranchStats || monthTrend.isLoading}
      />

      <div className="app-kpi-grid-4">
        <KpiCard title="Today's Expenses" value={todayExpenses ?? 0} prefix="₱" isLoading={isLoadingBranchStats} icon={TrendingDown} />
        <KpiCard title="Staff Clocked In" value={staffClockedIn ?? 0} isLoading={isLoadingBranchStats} icon={Users} />
        <KpiCard
          title="Low Stock Items"
          value={lowStockCount ?? 0}
          isLoading={isLoadingBranchStats}
          icon={PackageSearch}
          tone={(lowStockCount ?? 0) > 0 ? 'warning' : 'default'}
        />
        <KpiCard
          title="Inventory Alerts"
          value={inventoryAlertCount}
          isLoading={isLoadingInventoryRollup}
          icon={BellRing}
          tone={inventoryAlertCount > 0 ? 'warning' : 'default'}
          tooltip={`${criticalStockCount} critical, ${outOfStockCount} out of stock — items at or below a configured alert threshold. Excludes Low Stock Items (a separate, less severe threshold).`}
        />
      </div>

      <WidgetErrorBoundary label="Sales Trend">
        <SalesAnalyticsSection branchId={branchFilter} />
      </WidgetErrorBoundary>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DashboardPaymentBreakdown breakdown={paymentBreakdown} isLoading={isLoadingBranchStats} />
        <DashboardLowStockCard totalItems={lowStockCount} isLoading={isLoadingBranchStats} />
        <DashboardActiveBranchesCard
          activeCount={activeBranchCount}
          inactiveCount={inactiveBranchCount}
          isLoading={isLoadingBranchList}
        />
      </div>

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
