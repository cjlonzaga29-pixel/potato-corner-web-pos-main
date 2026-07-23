'use client';

import { Suspense } from 'react';
import { useSocketStore } from '@/stores/socket.store';
import { useShifts, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useBranchRealtimeSync, useAllBranchStats } from '@/hooks/queries/use-branches';
import { useProductRequests, useProductRequestRealtimeSync } from '@/hooks/queries/use-product-requests';
import { usePriceOverrides, usePriceOverrideRealtimeSync } from '@/hooks/queries/use-price-overrides';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { BranchSelector } from '@/components/admin/branch-selector';
import { DashboardKpiRow } from '@/components/admin/dashboard-kpi-row';
import { DashboardTrendsSection } from '@/components/admin/dashboard-trends-section';
import { DashboardPendingRequests } from '@/components/admin/dashboard-pending-requests';
import { DashboardPendingOverrides } from '@/components/admin/dashboard-pending-overrides';
import { DashboardShortcutCards } from '@/components/admin/dashboard-shortcut-cards';
import { InventoryRollupCard } from '@/components/admin/inventory-rollup-card';
import { LiveTransactionFeed } from '@/components/monitoring/live-transaction-feed';
import { ActiveCashiersPanel } from '@/components/monitoring/active-cashiers-panel';
import { LiveAlertsStream } from '@/components/monitoring/live-alerts-stream';
import { BranchConnectionPanel } from '@/components/monitoring/branch-connection-panel';

const SHIFT_LIST_LIMIT = 100;
const TOTAL_ONLY_LIMIT = 1;
const PANEL_LIST_LIMIT = 5;

function AdminDashboardPageContent() {
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);

  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  useProductRequestRealtimeSync();
  usePriceOverrideRealtimeSync();
  useBranchRealtimeSync();

  const { selectedBranchId } = useSelectedBranch();
  const branchFilter = selectedBranchId === 'all' ? undefined : selectedBranchId;

  const { data: activeShiftsData, isLoading: isLoadingActiveShifts } = useShifts({
    status: 'active',
    branch_id: branchFilter,
    limit: SHIFT_LIST_LIMIT,
  });
  const { data: flaggedShiftsData, isLoading: isLoadingFlaggedShifts } = useShifts({
    status: 'flagged',
    branch_id: branchFilter,
    limit: SHIFT_LIST_LIMIT,
  });
  const { data: pendingProductRequestsTotal, isLoading: isLoadingPendingProductRequestsTotal } = useProductRequests({
    status: 'pending',
    branch_id: branchFilter,
    limit: TOTAL_ONLY_LIMIT,
  });
  const { data: pendingPriceOverridesTotal, isLoading: isLoadingPendingPriceOverridesTotal } = usePriceOverrides({
    status: 'pending',
    branch_id: branchFilter,
    limit: TOTAL_ONLY_LIMIT,
  });
  const { data: pendingProductRequestsList, isLoading: isLoadingPendingProductRequestsList } = useProductRequests({
    status: 'pending',
    branch_id: branchFilter,
    limit: PANEL_LIST_LIMIT,
  });
  const { data: pendingPriceOverridesList, isLoading: isLoadingPendingPriceOverridesList } = usePriceOverrides({
    status: 'pending',
    branch_id: branchFilter,
    limit: PANEL_LIST_LIMIT,
  });
  const { data: branchStats, isLoading: isLoadingBranchStats } = useAllBranchStats(branchFilter);

  const liveRevenue = activeShiftsData?.shifts.reduce(
    (sum, shift) => sum + shift.cash_sales_total + shift.gcash_sales_total,
    0,
  );
  const pendingApprovalsCount =
    pendingProductRequestsTotal !== undefined && pendingPriceOverridesTotal !== undefined
      ? pendingProductRequestsTotal.total + pendingPriceOverridesTotal.total
      : undefined;
  const isLoadingApprovals = isLoadingPendingProductRequestsTotal || isLoadingPendingPriceOverridesTotal;

  const transactionsCount = branchStats?.reduce((sum, b) => sum + b.todayTransactionCount, 0);
  const activeCashiersCount = branchStats?.reduce((sum, b) => sum + b.activeStaffCount, 0);
  const lowStockCount = branchStats?.reduce((sum, b) => sum + b.lowStockIngredientCount, 0);
  const grossSales = branchStats?.reduce((sum, b) => sum + b.todayGrossSales, 0);
  const expenses = branchStats?.reduce((sum, b) => sum + b.todayExpenses, 0);
  const netProfit = branchStats?.reduce((sum, b) => sum + b.todayNetProfit, 0);

  const connectionLabel = isReconnecting ? 'Reconnecting' : isConnected ? 'Connected' : 'Disconnected';
  const connectionColor = isReconnecting ? 'bg-yellow-500' : isConnected ? 'bg-green-500' : 'bg-red-500';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Super Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">Live overview across every branch.</p>
        </div>
        <span
          title={connectionLabel}
          aria-label={connectionLabel}
          className={`h-2.5 w-2.5 rounded-full ${connectionColor}`}
        />
      </div>

      <BranchSelector />

      <DashboardKpiRow
        activeShiftsCount={activeShiftsData?.total}
        liveRevenue={liveRevenue}
        pendingApprovalsCount={pendingApprovalsCount}
        flaggedShiftsCount={flaggedShiftsData?.total}
        transactionsCount={transactionsCount}
        activeCashiersCount={activeCashiersCount}
        lowStockCount={lowStockCount}
        grossSales={grossSales}
        expenses={expenses}
        netProfit={netProfit}
        isLoadingShifts={isLoadingActiveShifts}
        isLoadingRevenue={isLoadingActiveShifts}
        isLoadingApprovals={isLoadingApprovals}
        isLoadingFlagged={isLoadingFlaggedShifts}
        isLoadingStats={isLoadingBranchStats}
      />

      <DashboardTrendsSection branchFilter={branchFilter} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardPendingRequests
          requests={pendingProductRequestsList?.requests}
          isLoading={isLoadingPendingProductRequestsList}
        />
        <DashboardPendingOverrides
          overrides={pendingPriceOverridesList?.overrides}
          isLoading={isLoadingPendingPriceOverridesList}
        />
      </div>

      <InventoryRollupCard />

      <DashboardShortcutCards />

      <div className="space-y-4 border-t pt-6">
        <h2 className="text-lg font-semibold">Live Activity</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <LiveTransactionFeed />
          <ActiveCashiersPanel />
          <LiveAlertsStream />
          <BranchConnectionPanel />
        </div>
      </div>
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
