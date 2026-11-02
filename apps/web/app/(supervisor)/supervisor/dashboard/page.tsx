'use client';

import { useRouter } from 'next/navigation';
import { Wallet, CalendarDays, Receipt, BadgeDollarSign, TrendingDown, Users, PackageSearch, BellRing } from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { DashboardInventoryAlerts } from '@/components/supervisor/dashboard-inventory-alerts';
import { transferPrepareHref } from '@/lib/transfer-links';
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
import { stockAlertCounts, stockAlertRows } from '@/lib/inventory-stock-status';
import { useAttendanceSummary, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

const RECENT_TRANSACTIONS_LIMIT = 10;

// POS-PERF-P47 — destinations for the actionable cards. Both read the
// sidebar's active branch from the same store as this dashboard, so a branch
// switch changes the counts and what the link opens together.
const INVENTORY_LOW_HREF = '/supervisor/inventory?status=low';
const INVENTORY_ALERTS_HREF = '/supervisor/inventory?status=alerts';
const ATTENDANCE_HREF = '/supervisor/attendance';

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

  const { data: branchStats, isLoading: isStatsLoading } = useAllBranchStats(activeBranchId ?? undefined);
  const { data: transactionsData, isLoading: isTransactionsLoading } = useTransactions({
    branch_id: activeBranchId ?? undefined,
    limit: RECENT_TRANSACTIONS_LIMIT,
  });
  const alertsQuery = useBranchInventoryStockAlerts(activeBranchId);
  // POS-PERF-P47 — attendance from clock-in/out records only (never logins
  // or socket presence); same rule as the Staff Clocked In KPI.
  const attendanceQuery = useAttendanceSummary(activeBranchId);
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
      // GET /api/branches?status=active is Supervisor-branch-assignment-scoped
      // (lib/branch-access.ts) — an empty result here means this account has
      // zero active UserBranchAssignment rows, not that the system has no
      // active branches. Fail closed: no assignments, no implicit access.
      return (
        <EmptyState
          title="No branches assigned"
          description="Contact your administrator to get access to a branch."
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
  //
  // POS-PERF-P47 — every branch-scoped payload is matched against the
  // active branch before use: a response for the previously selected branch
  // can never be shown under the new branch's name while a refetch runs.
  const todayStats = branchStats?.find((s) => s.branchId === activeBranchId);
  const averageOrderValue =
    todayStats && todayStats.todayTransactionCount > 0 ? todayStats.todayGrossSales / todayStats.todayTransactionCount : 0;
  const alertsData = alertsQuery.data?.branch_id === activeBranchId ? alertsQuery.data : undefined;
  const alerts = alertsData ? stockAlertRows(alertsData) : undefined;
  const isAlertsLoading = alertsQuery.isLoading || (alertsQuery.data !== undefined && alerts === undefined);
  const alertCount = alerts?.length ?? 0;
  const { out: outCount, insufficient: insufficientCount, critical: criticalCount, low: lowCount } = stockAlertCounts(alerts ?? []);
  const attentionLabel = [outCount > 0 && `${outCount} out of stock`, insufficientCount > 0 && `${insufficientCount} insufficient for a serving`, criticalCount > 0 && `${criticalCount} critical`]
    .filter(Boolean)
    .join(', ');
  const attendanceSummary = attendanceQuery.data?.branch_id === activeBranchId ? attendanceQuery.data : undefined;
  const isAttendanceLoading = attendanceQuery.isLoading || (attendanceQuery.data !== undefined && attendanceSummary === undefined);
  const isTodayStatsLoading = isStatsLoading || (branchStats !== undefined && todayStats === undefined);

  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader
        title="Supervisor Dashboard"
        // POS-PERF-P47 — activeBranch (the object) is not persisted across a
        // reload, only its id; fall back to the loaded branch list's name so
        // the header never shows a raw UUID.
        subtitle={`${activeBranch?.name ?? branchesData?.branches.find((b) => b.id === activeBranchId)?.name ?? 'Selected branch'} — ${formatDate(new Date())}`}
        actions={<DashboardConnectionBadge isConnected={isConnected} isReconnecting={isReconnecting} />}
      />

      <div className="app-kpi-grid-4">
        <KpiCard
          title="Gross Sales Today"
          value={todayStats?.todayGrossSales ?? 0}
          prefix="₱"
          isLoading={isTodayStatsLoading}
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
        <KpiCard title="Today's Transactions" value={todayStats?.todayTransactionCount ?? 0} isLoading={isTodayStatsLoading} icon={Receipt} />
        <KpiCard title="Average Order Value" value={averageOrderValue} prefix="₱" isLoading={isTodayStatsLoading} icon={BadgeDollarSign} />
      </div>

      <div className="app-kpi-grid-4">
        <KpiCard
          title="Today's Expenses"
          value={todayStats?.todayExpenses ?? 0}
          prefix="₱"
          isLoading={isTodayStatsLoading}
          icon={TrendingDown}
        />
        <KpiCard
          title="Staff Clocked In"
          value={attendanceSummary?.clocked_in.length ?? 0}
          isLoading={isAttendanceLoading}
          icon={Users}
          href={ATTENDANCE_HREF}
          actionLabel="View attendance"
          tooltip="Staff with an open attendance clock-in at this branch right now. Logins and connected devices are not counted."
        />
        <KpiCard
          title="Low Stock Items"
          value={lowCount}
          isLoading={isAlertsLoading}
          icon={PackageSearch}
          tone={lowCount > 0 ? 'warning' : 'default'}
          href={INVENTORY_LOW_HREF}
          actionLabel="View low stock"
          tooltip="Inventory items at or below their low-stock threshold but above the critical threshold. Items without thresholds are never low; they alert only when they run out."
        />
        <KpiCard
          title="Inventory Alerts"
          value={alertCount}
          isLoading={isAlertsLoading}
          icon={BellRing}
          tone={outCount + insufficientCount + criticalCount > 0 ? 'danger' : alertCount > 0 ? 'warning' : 'default'}
          href={INVENTORY_ALERTS_HREF}
          actionLabel={attentionLabel ? `View alerts (${attentionLabel})` : 'View alerts'}
          tooltip="Tracked inventory items needing attention: out of stock, insufficient for one serving of something on the POS, critical and low. Counts each item once, not products or sizes."
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
          onRowClick={() => router.push('/supervisor/reports')}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        <DashboardInventoryAlerts
          alerts={alerts}
          isLoading={isAlertsLoading}
          href={INVENTORY_ALERTS_HREF}
          setupIssues={alertsData?.setup_issues}
          setupHref="/supervisor/products"
          prepareTransferHref={
            (branchesData?.branches.length ?? 0) > 1
              ? (alert) => transferPrepareHref('/supervisor', { toBranchId: activeBranchId, inventoryItemId: alert.inventory_item_id })
              : undefined
          }
        />
        <DashboardAttendanceOverview
          summary={attendanceSummary}
          isLoading={isAttendanceLoading}
          isError={attendanceQuery.isError}
          href={ATTENDANCE_HREF}
        />
      </div>
    </div>
  );
}
