'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startOfDay } from 'date-fns';
import { ShoppingCart, Timer, PackagePlus, Receipt } from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardShiftCard } from '@/components/supervisor/dashboard-shift-card';
import { DashboardInventoryAlerts } from '@/components/supervisor/dashboard-inventory-alerts';
import { DashboardAttendanceOverview } from '@/components/supervisor/dashboard-attendance-overview';
import { DashboardTransactionsFeed } from '@/components/supervisor/dashboard-transactions-feed';
import { formatDate } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useSocketStore } from '@/stores/socket.store';
import { useBranch, useAllBranchStats } from '@/hooks/queries/use-branches';
import { useCurrentShift, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useBranchInventoryAlerts, useInventoryRealtimeSync } from '@/hooks/queries/use-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useProductRequests, useProductRequestsRealtimeSync } from '@/hooks/queries/use-product-requests';
import { useFlavorRequests, useFlavorRequestsRealtimeSync } from '@/hooks/queries/use-flavor-requests';
import { usePriceOverrides, usePriceOverridesRealtimeSync } from '@/hooks/queries/use-price-overrides';

const RECENT_TRANSACTIONS_LIMIT = 10;
const ATTENDANCE_OVERVIEW_LIMIT = 100;
const TOTAL_ONLY_LIMIT = 1;

const QUICK_ACTIONS = [
  { label: 'Open POS Terminal', href: '/branch/terminal', icon: ShoppingCart },
  { label: 'Open Shift', href: '/branch/shift/open', icon: Timer },
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
  useInventoryRealtimeSync(branchId);
  useAttendanceRealtimeSync();
  useProductRequestsRealtimeSync();
  useFlavorRequestsRealtimeSync();
  usePriceOverridesRealtimeSync();

  // Calendar-day boundary, computed once on mount — deliberately not
  // reactive to clock ticking, same as the supervisor dashboard's
  // attendance panel ("today so far", not a live-updating window).
  const [{ from, to }] = useState(() => {
    const now = new Date();
    return { from: startOfDay(now).toISOString(), to: now.toISOString() };
  });

  const { data: branch } = useBranch(branchId);
  const { data: shift, isLoading: isShiftLoading } = useCurrentShift(branchId);
  const { data: branchStats, isLoading: isLoadingStats } = useAllBranchStats(branchId);
  const { data: transactionsData, isLoading: isTransactionsLoading } = useTransactions({
    branch_id: branchId,
    limit: RECENT_TRANSACTIONS_LIMIT,
  });
  const { data: alertsData, isLoading: isAlertsLoading } = useBranchInventoryAlerts(branchId);
  const { data: attendanceData, isLoading: isAttendanceLoading } = useAttendanceByBranch(branchId, {
    from,
    to,
    limit: ATTENDANCE_OVERVIEW_LIMIT,
  });
  const { data: pendingProductRequests, isLoading: isLoadingProductRequests } = useProductRequests({
    status: 'pending',
    branch_id: branchId,
    limit: TOTAL_ONLY_LIMIT,
  });
  const { data: pendingFlavorRequests, isLoading: isLoadingFlavorRequests } = useFlavorRequests({
    status: 'pending',
    branch_id: branchId,
    limit: TOTAL_ONLY_LIMIT,
  });
  const { data: pendingPriceOverrides, isLoading: isLoadingPriceOverrides } = usePriceOverrides({
    status: 'pending',
    branch_id: branchId,
    limit: TOTAL_ONLY_LIMIT,
  });

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
        <KpiCard title="Today's Revenue" value={todayStats?.todayRevenue ?? 0} prefix="₱" isLoading={isLoadingStats} />
        <KpiCard title="Today's Transactions" value={todayStats?.todayTransactionCount ?? 0} isLoading={isLoadingStats} />
        <KpiCard title="Average Order Value" value={averageOrderValue} prefix="₱" isLoading={isLoadingStats} />
        <DashboardShiftCard shift={shift} isLoading={isShiftLoading} />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Pending Approvals</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            title="Pending Product Requests"
            value={pendingProductRequests?.total ?? 0}
            isLoading={isLoadingProductRequests}
            tone={pendingProductRequests?.total ? 'warning' : 'default'}
          />
          <KpiCard
            title="Pending Flavor Requests"
            value={pendingFlavorRequests?.total ?? 0}
            isLoading={isLoadingFlavorRequests}
            tone={pendingFlavorRequests?.total ? 'warning' : 'default'}
          />
          <KpiCard
            title="Pending Price Overrides"
            value={pendingPriceOverrides?.total ?? 0}
            isLoading={isLoadingPriceOverrides}
            tone={pendingPriceOverrides?.total ? 'warning' : 'default'}
          />
        </div>
      </div>

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

      <DashboardTransactionsFeed
        transactions={transactionsData?.transactions}
        isLoading={isTransactionsLoading}
        onRowClick={() => router.push('/branch/receipts')}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardInventoryAlerts alerts={alertsData?.alerts} isLoading={isAlertsLoading} />
        <DashboardAttendanceOverview records={attendanceData?.records} isLoading={isAttendanceLoading} />
      </div>
    </div>
  );
}
