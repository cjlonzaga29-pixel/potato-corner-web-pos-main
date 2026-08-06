'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startOfDay } from 'date-fns';
import { Wallet, CalendarDays, Receipt, BadgeDollarSign, TrendingDown, Users, PackageSearch, BellRing } from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { DashboardInventoryAlerts } from '@/components/supervisor/dashboard-inventory-alerts';
import { DashboardAttendanceOverview } from '@/components/supervisor/dashboard-attendance-overview';
import { DashboardTransactionsFeed } from '@/components/supervisor/dashboard-transactions-feed';
import { SalesAnalyticsSection } from '@/components/shared/dashboard/sales-analytics-section';
import { TopProductsPanel } from '@/components/shared/dashboard/top-products-panel';
import { WidgetErrorBoundary } from '@/components/shared/widget-error-boundary';
import { DashboardPageHeader, DashboardConnectionBadge } from '@/components/shared/dashboard/dashboard-page-header';
import { formatDate } from '@/lib/utils';
import { manilaToday, manilaMonthStart } from '@/lib/manila-date';
import { useBranchStore } from '@/stores/branch.store';
import { useSocketStore } from '@/stores/socket.store';
import { useBranches, useAllBranchStats } from '@/hooks/queries/use-branches';
import { useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useDashboardSalesTrendReport, useInventoryAnalyticsRealtimeSync } from '@/hooks/queries/use-reports';
import { useBranchInventoryStockAlerts, useInventoryStockRealtimeSync } from '@/hooks/queries/use-universal-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

const RECENT_TRANSACTIONS_LIMIT = 10;
const ATTENDANCE_OVERVIEW_LIMIT = 100;

export default function SupervisorDashboardPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const activeBranch = useBranchStore((s) => s.activeBranch);
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);
  // BranchSelector (mounted in the sidebar) drives activeBranchId off this
  // same query — reused here (same key, no extra request) so the dashboard
  // can tell "still loading the active-branch list" and "failed to load it"
  // apart from "the account genuinely has zero active branches", instead of
  // collapsing all three into the same "No branch configured" empty state.
  const { isLoading: isBranchesLoading, isError: isBranchesError, data: branchesData } = useBranches({
    status: 'active',
    limit: 100,
  });

  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  useInventoryStockRealtimeSync(activeBranchId);
  useInventoryAnalyticsRealtimeSync();
  useAttendanceRealtimeSync();
  useExpensesRealtimeSync();

  // Calendar-day boundary, computed once on mount — deliberately not
  // reactive to clock ticking (the dashboard's attendance panel shows
  // "today so far", not a live-updating window).
  const [{ from, to }] = useState(() => {
    const now = new Date();
    return { from: startOfDay(now).toISOString(), to: now.toISOString() };
  });

  const { data: branchStats, isLoading: isStatsLoading } = useAllBranchStats(activeBranchId ?? undefined);
  const { data: transactionsData, isLoading: isTransactionsLoading } = useTransactions({
    branch_id: activeBranchId ?? undefined,
    limit: RECENT_TRANSACTIONS_LIMIT,
  });
  const { data: alertsData, isLoading: isAlertsLoading } = useBranchInventoryStockAlerts(activeBranchId);
  const { data: attendanceData, isLoading: isAttendanceLoading } = useAttendanceByBranch(activeBranchId, {
    from,
    to,
    limit: ATTENDANCE_OVERVIEW_LIMIT,
  });
  const monthTrend = useDashboardSalesTrendReport({
    date_from: manilaMonthStart(),
    date_to: manilaToday(),
    branch_id: activeBranchId ?? undefined,
    page: 1,
    limit: MAX_LIST_LIMIT,
  });
  const grossSalesMonth = monthTrend.data?.data.reduce((sum, row) => sum + row.gross_sales, 0);

  if (!activeBranchId) {
    if (isBranchesLoading) {
      return (
        <div className="flex justify-center py-12">
          <LoadingSpinner size="lg" />
        </div>
      );
    }

    if (isBranchesError) {
      return (
        <EmptyState
          title="Couldn't load your branches"
          description="Something went wrong fetching active branches. Try refreshing the page."
        />
      );
    }

    if ((branchesData?.branches.length ?? 0) === 0) {
      return (
        <EmptyState
          title="No active branches available"
          description="There are no active branches yet. Ask a Super Admin to create or activate one."
        />
      );
    }

    return (
      <EmptyState
        title="No branch configured"
        description="Select an active branch from the sidebar to view its dashboard."
      />
    );
  }

  // Today's totals (Gross Sales / Transactions / Discounts) come from the
  // branch's day-level stats, not any individual shift — a shift that closes
  // mid-day must not zero out sales that already happened today (matches the
  // branch-role dashboard's todayGrossSales/todayTransactionCount sourcing).
  // Shifts are auto-managed per cashier now (Phase 4-9), so there is no
  // single "the branch's shift" left to show a dedicated card for.
  const todayStats = branchStats?.[0];
  const averageOrderValue =
    todayStats && todayStats.todayTransactionCount > 0 ? todayStats.todayGrossSales / todayStats.todayTransactionCount : 0;
  const alertCount = alertsData?.alerts.length ?? 0;

  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader
        title="Supervisor Dashboard"
        subtitle={`${activeBranch?.name ?? activeBranchId} — ${formatDate(new Date())}`}
        actions={<DashboardConnectionBadge isConnected={isConnected} isReconnecting={isReconnecting} />}
      />

      <div className="app-kpi-grid-4">
        <KpiCard
          title="Gross Sales Today"
          value={todayStats?.todayGrossSales ?? 0}
          prefix="₱"
          isLoading={isStatsLoading}
          icon={Wallet}
          emphasize
          tooltip="Completed sales for the selected Manila business day."
        />
        <KpiCard
          title="Gross Sales This Month"
          value={grossSalesMonth ?? 0}
          prefix="₱"
          isLoading={monthTrend.isLoading}
          icon={CalendarDays}
          tooltip="Completed sales for the current Manila calendar month."
        />
        <KpiCard title="Today's Transactions" value={todayStats?.todayTransactionCount ?? 0} isLoading={isStatsLoading} icon={Receipt} />
        <KpiCard title="Average Order Value" value={averageOrderValue} prefix="₱" isLoading={isStatsLoading} icon={BadgeDollarSign} />
      </div>

      <div className="app-kpi-grid-4">
        <KpiCard
          title="Today's Expenses"
          value={todayStats?.todayExpenses ?? 0}
          prefix="₱"
          isLoading={isStatsLoading}
          icon={TrendingDown}
        />
        <KpiCard title="Staff Clocked In" value={todayStats?.staffTimedInCount ?? 0} isLoading={isStatsLoading} icon={Users} />
        <KpiCard
          title="Low Stock Items"
          value={todayStats?.lowStockIngredientCount ?? 0}
          isLoading={isStatsLoading}
          icon={PackageSearch}
          tone={(todayStats?.lowStockIngredientCount ?? 0) > 0 ? 'warning' : 'default'}
        />
        <KpiCard
          title="Inventory Alerts"
          value={alertCount}
          isLoading={isAlertsLoading}
          icon={BellRing}
          tone={alertCount > 0 ? 'warning' : 'default'}
        />
      </div>

      <WidgetErrorBoundary label="Sales Trend">
        <SalesAnalyticsSection branchId={activeBranchId} />
      </WidgetErrorBoundary>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <WidgetErrorBoundary label="Top Products">
          <TopProductsPanel branchId={activeBranchId} />
        </WidgetErrorBoundary>
        <DashboardTransactionsFeed
          transactions={transactionsData?.transactions}
          isLoading={isTransactionsLoading}
          onRowClick={() => router.push('/supervisor/cash')}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardInventoryAlerts alerts={alertsData?.alerts} isLoading={isAlertsLoading} />
        <DashboardAttendanceOverview records={attendanceData?.records} isLoading={isAttendanceLoading} />
      </div>
    </div>
  );
}
