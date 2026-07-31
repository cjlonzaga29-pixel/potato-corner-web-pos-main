'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startOfDay } from 'date-fns';
import { ShoppingCart, Fingerprint, PackagePlus, Receipt } from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardInventoryAlerts } from '@/components/supervisor/dashboard-inventory-alerts';
import { DashboardAttendanceOverview } from '@/components/supervisor/dashboard-attendance-overview';
import { DashboardTransactionsFeed } from '@/components/supervisor/dashboard-transactions-feed';
import { SalesAnalyticsSection } from '@/components/shared/dashboard/sales-analytics-section';
import { TopProductsPanel } from '@/components/shared/dashboard/top-products-panel';
import { InventoryConsumptionPanel } from '@/components/shared/dashboard/inventory-consumption-panel';
import { WidgetErrorBoundary } from '@/components/shared/widget-error-boundary';
import { formatDate } from '@/lib/utils';
import { manilaToday, manilaMonthStart } from '@/lib/manila-date';
import { useAuth } from '@/hooks/use-auth';
import { useSocketStore } from '@/stores/socket.store';
import { useBranch, useAllBranchStats } from '@/hooks/queries/use-branches';
import { useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useDashboardSalesTrendReport, useInventoryAnalyticsRealtimeSync } from '@/hooks/queries/use-reports';
import { useBranchInventoryStockAlerts, useInventoryStockRealtimeSync } from '@/hooks/queries/use-universal-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

const RECENT_TRANSACTIONS_LIMIT = 10;
const ATTENDANCE_OVERVIEW_LIMIT = 100;

const QUICK_ACTIONS = [
  { label: 'Open POS Terminal', href: '/branch/terminal', icon: ShoppingCart },
  { label: 'Clock In / Out', href: '/branch/clock-in', icon: Fingerprint },
  { label: 'Receive Stock', href: '/branch/inventory/stock-in', icon: PackagePlus },
  { label: 'Log Expense', href: '/branch/expenses', icon: Receipt },
] as const;

/**
 * The `branch` role's own landing page — CR-003. Unlike the supervisor
 * dashboard (which lets one supervisor flip between several branches via
 * useBranchStore), a branch account is bound to exactly one physical
 * branch, so this reads branchId straight off the JWT the same way the
 * former POS shell did (user.branchIds[0]), not from a branch selector.
 */
export default function BranchDashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);

  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  useInventoryStockRealtimeSync(branchId);
  useInventoryAnalyticsRealtimeSync();
  useAttendanceRealtimeSync();
  useExpensesRealtimeSync();

  // Calendar-day boundary, computed once on mount — deliberately not
  // reactive to clock ticking, same as the supervisor dashboard's
  // attendance panel ("today so far", not a live-updating window).
  const [{ from, to }] = useState(() => {
    const now = new Date();
    return { from: startOfDay(now).toISOString(), to: now.toISOString() };
  });

  const { data: branch } = useBranch(branchId);
  const { data: branchStats, isLoading: isLoadingStats } = useAllBranchStats(branchId);
  const { data: transactionsData, isLoading: isTransactionsLoading } = useTransactions({
    branch_id: branchId,
    limit: RECENT_TRANSACTIONS_LIMIT,
  });
  const { data: alertsData, isLoading: isAlertsLoading } = useBranchInventoryStockAlerts(branchId);
  const { data: attendanceData, isLoading: isAttendanceLoading } = useAttendanceByBranch(branchId, {
    from,
    to,
    limit: ATTENDANCE_OVERVIEW_LIMIT,
  });
  const monthTrend = useDashboardSalesTrendReport({
    date_from: manilaMonthStart(),
    date_to: manilaToday(),
    branch_id: branchId,
    page: 1,
    limit: MAX_LIST_LIMIT,
  });
  const grossSalesMonth = monthTrend.data?.data.reduce((sum, row) => sum + row.gross_sales, 0);

  if (!branchId) {
    return (
      <EmptyState
        title="No branch assigned"
        description="Contact your supervisor to get staffed to a branch."
      />
    );
  }

  const todayStats = branchStats?.[0];
  const averageOrderValue =
    todayStats && todayStats.todayTransactionCount > 0 ? todayStats.todayGrossSales / todayStats.todayTransactionCount : 0;
  const netProfitLabel = todayStats?.isNetProfitEstimated ? 'Estimated Net Profit' : 'Net Profit';
  const netProfitTooltip = todayStats?.isNetProfitEstimated
    ? `Net Sales - COGS - Expenses. Cost data was missing for ${todayStats.missingCostItemCount} sold item(s), so this figure is an estimate.`
    : 'Net Sales - COGS - Expenses';
  const connectionLabel = isReconnecting ? 'Reconnecting' : isConnected ? 'Connected' : 'Disconnected';
  const connectionColor = isReconnecting ? 'bg-warning' : isConnected ? 'bg-success' : 'bg-destructive';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Branch Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {branch?.name ?? branchId} — {formatDate(new Date())}
          </p>
        </div>
        <span
          title={connectionLabel}
          aria-label={connectionLabel}
          className={`h-2.5 w-2.5 rounded-full ${connectionColor}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <KpiCard
          title="Daily Gross Sales"
          value={todayStats?.todayGrossSales ?? 0}
          prefix="₱"
          isLoading={isLoadingStats}
          tooltip="Completed sales for the selected Manila business day."
        />
        <KpiCard
          title="Monthly Gross Sales"
          value={grossSalesMonth ?? 0}
          prefix="₱"
          isLoading={monthTrend.isLoading}
          tooltip="Completed sales for the current Manila calendar month."
        />
        <KpiCard title="Net Sales" value={todayStats?.todayNetSales ?? 0} prefix="₱" isLoading={isLoadingStats} />
        <KpiCard title="Today's Transactions" value={todayStats?.todayTransactionCount ?? 0} isLoading={isLoadingStats} />
        <KpiCard title="Average Order Value" value={averageOrderValue} prefix="₱" isLoading={isLoadingStats} />
        <KpiCard
          title={netProfitLabel}
          value={todayStats?.todayNetProfit ?? 0}
          prefix="₱"
          isLoading={isLoadingStats}
          tone={(todayStats?.todayNetProfit ?? 0) < 0 ? 'negative' : 'default'}
          tooltip={netProfitTooltip}
        />
        <KpiCard title="Expenses" value={todayStats?.todayExpenses ?? 0} prefix="₱" isLoading={isLoadingStats} />
        <KpiCard
          title="Low Stock Items"
          value={todayStats?.lowStockIngredientCount ?? 0}
          isLoading={isLoadingStats}
          tone={(todayStats?.lowStockIngredientCount ?? 0) > 0 ? 'warning' : 'default'}
        />
        <KpiCard title="Staff Timed In" value={todayStats?.staffTimedInCount ?? 0} isLoading={isLoadingStats} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Payment Collections Today</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(['cash', 'gcash', 'maya', 'other'] as const).map((method) => (
            <div key={method} className="space-y-1">
              <p className="text-xs capitalize text-muted-foreground">{method}</p>
              <p className="text-lg font-semibold">
                {isLoadingStats ? '—' : `₱${(todayStats?.paymentBreakdown[method].total ?? 0).toFixed(2)}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {isLoadingStats ? '' : `${todayStats?.paymentBreakdown[method].count ?? 0} txns`}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <Button key={action.href} variant="outline" className="h-auto flex-col gap-2 py-4" asChild>
              <Link href={action.href}>
                <action.icon className="h-5 w-5" />
                <span className="text-xs font-medium">{action.label}</span>
              </Link>
            </Button>
          ))}
        </CardContent>
      </Card>

      <WidgetErrorBoundary label="Sales Trend">
        <SalesAnalyticsSection branchId={branchId} />
      </WidgetErrorBoundary>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <WidgetErrorBoundary label="Top Products">
          <TopProductsPanel branchId={branchId} />
        </WidgetErrorBoundary>
        <WidgetErrorBoundary label="Inventory Consumption">
          <InventoryConsumptionPanel branchId={branchId} />
        </WidgetErrorBoundary>
        <DashboardTransactionsFeed
          transactions={transactionsData?.transactions}
          isLoading={isTransactionsLoading}
          onRowClick={() => router.push('/branch/receipts')}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardInventoryAlerts alerts={alertsData?.alerts} isLoading={isAlertsLoading} />
        <DashboardAttendanceOverview records={attendanceData?.records} isLoading={isAttendanceLoading} />
      </div>
    </div>
  );
}
