'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ShoppingCart,
  PackagePlus,
  SlidersHorizontal,
  Receipt,
  Wallet,
  CalendarDays,
  BadgeDollarSign,
  TrendingDown,
  Users,
  PackageSearch,
  BellRing,
} from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { PaymentMethodGrid } from '@/components/shared/dashboard/payment-method-grid';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardTransactionsFeed } from '@/components/supervisor/dashboard-transactions-feed';
import { SalesAnalyticsSection } from '@/components/shared/dashboard/sales-analytics-section';
import { InventoryConsumptionPanel } from '@/components/shared/dashboard/inventory-consumption-panel';
import { WidgetErrorBoundary } from '@/components/shared/widget-error-boundary';
import { DashboardPageHeader, DashboardConnectionBadge } from '@/components/shared/dashboard/dashboard-page-header';
import { formatDate } from '@/lib/utils';
import { manilaToday, manilaMonthStart } from '@/lib/manila-date';
import { useAuth } from '@/hooks/use-auth';
import { useSocketStore } from '@/stores/socket.store';
import { useBranch, useAllBranchStats } from '@/hooks/queries/use-branches';
import { useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useDashboardSalesTrendReport, useInventoryAnalyticsRealtimeSync } from '@/hooks/queries/use-reports';
import { useBranchInventoryStockAlerts, useInventoryStockRealtimeSync } from '@/hooks/queries/use-universal-inventory';
import { useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

const RECENT_TRANSACTIONS_LIMIT = 10;

const QUICK_ACTIONS = [
  { label: 'Open POS', href: '/branch/terminal', icon: ShoppingCart },
  { label: 'Receive Stock', href: '/branch/inventory/stock-in', icon: PackagePlus },
  { label: 'Stock Adjustment', href: '/branch/inventory/adjust', icon: SlidersHorizontal },
  { label: 'Log Expense', href: '/branch/expenses', icon: Receipt },
] as const;

/**
 * The `branch` role's own landing page — CR-003. Unlike the supervisor
 * dashboard (which lets one supervisor flip between several branches via
 * useBranchStore), a branch account is bound to exactly one physical
 * branch, so this reads branchId straight off the JWT the same way the
 * former POS shell did (user.branchIds[0]), not from a branch selector.
 *
 * TASK 124: trimmed to a branch-manager-focused layout — 2 KPI rows, a
 * compact operational-status row, Payment Collections, Quick Actions,
 * Sales Trend, Inventory Status, and Recent Activity. Same data sources
 * and formulas as before; only the composition changed.
 *
 * TASK 165: Net Sales Today and (Estimated) Profit Today were removed from
 * the KPI rows — neither metric nor its calculation exists anywhere on the
 * dashboard anymore. The former standalone Low Stock Items / Inventory
 * Alerts row was folded into KPI row 2 alongside Today's Expenses and Staff
 * Clocked In, giving the page the same fixed 2-row, 8-card KPI layout as
 * the Admin/Super Admin dashboard.
 */
export default function BranchDashboardPage() {
  const router = useRouter();
  const { user, isLoading: isAuthLoading } = useAuth();
  const branchId = user?.branchIds[0];
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);

  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  useInventoryStockRealtimeSync(branchId);
  useInventoryAnalyticsRealtimeSync();
  useExpensesRealtimeSync();

  const { data: branch } = useBranch(branchId);
  const { data: branchStats, isLoading: isLoadingStats } = useAllBranchStats(branchId);
  const { data: transactionsData, isLoading: isTransactionsLoading } = useTransactions({
    branch_id: branchId,
    limit: RECENT_TRANSACTIONS_LIMIT,
  });
  const { data: alertsData, isLoading: isAlertsLoading } = useBranchInventoryStockAlerts(branchId);
  const monthTrend = useDashboardSalesTrendReport({
    date_from: manilaMonthStart(),
    date_to: manilaToday(),
    branch_id: branchId,
    page: 1,
    limit: MAX_LIST_LIMIT,
  });
  const grossSalesMonth = monthTrend.data?.data.reduce((sum, row) => sum + row.gross_sales, 0);

  // Task 209.54 — a hard reload starts with no `user` (the access token is
  // memory-only; useAuth's silent refresh on mount is what repopulates it),
  // so `branchId` is briefly undefined on every reload/first paint even for
  // a correctly-staffed account. Checking `isAuthLoading` first stops that
  // window from flashing this permission-shaped "No branch assigned" empty
  // state — it now only ever shows once auth has actually settled and the
  // account genuinely has no branch.
  if (isAuthLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

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
  const alertCount = alertsData?.alerts.length ?? 0;

  return (
    <div className="app-section app-section-gap">
      <DashboardPageHeader
        title="Branch Dashboard"
        subtitle={`${branch?.name ?? branchId} — ${formatDate(new Date())}`}
        actions={<DashboardConnectionBadge isConnected={isConnected} isReconnecting={isReconnecting} />}
      />

      <div className="app-kpi-grid-4">
        <KpiCard
          title="Gross Sales Today"
          value={todayStats?.todayGrossSales ?? 0}
          prefix="₱"
          isLoading={isLoadingStats}
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
        <KpiCard title="Today's Transactions" value={todayStats?.todayTransactionCount ?? 0} isLoading={isLoadingStats} icon={Receipt} />
        <KpiCard title="Average Order Value" value={averageOrderValue} prefix="₱" isLoading={isLoadingStats} icon={BadgeDollarSign} />
      </div>

      <div className="app-kpi-grid-4">
        <KpiCard
          title="Today's Expenses"
          value={todayStats?.todayExpenses ?? 0}
          prefix="₱"
          isLoading={isLoadingStats}
          icon={TrendingDown}
        />
        <KpiCard title="Staff Clocked In" value={todayStats?.staffTimedInCount ?? 0} isLoading={isLoadingStats} icon={Users} />
        <KpiCard
          title="Low Stock Items"
          value={todayStats?.lowStockIngredientCount ?? 0}
          isLoading={isLoadingStats}
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Payment Collections Today</CardTitle>
          </CardHeader>
          <CardContent>
            <PaymentMethodGrid
              breakdown={todayStats?.paymentBreakdown}
              isLoading={isLoadingStats}
              showCount
              className="sm:grid-cols-4"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {QUICK_ACTIONS.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="hover-elevate flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-border/60 bg-card text-center"
              >
                <action.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                <span className="text-xs font-medium">{action.label}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <WidgetErrorBoundary label="Sales Trend">
        <SalesAnalyticsSection branchId={branchId} />
      </WidgetErrorBoundary>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <WidgetErrorBoundary label="Inventory Status">
          <InventoryConsumptionPanel branchId={branchId} />
        </WidgetErrorBoundary>
        <DashboardTransactionsFeed
          transactions={transactionsData?.transactions}
          isLoading={isTransactionsLoading}
          onRowClick={() => router.push('/branch/receipts')}
        />
      </div>
    </div>
  );
}
