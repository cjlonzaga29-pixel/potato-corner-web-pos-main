'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startOfDay } from 'date-fns';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { DashboardShiftCard } from '@/components/supervisor/dashboard-shift-card';
import { DashboardInventoryAlerts } from '@/components/supervisor/dashboard-inventory-alerts';
import { DashboardAttendanceOverview } from '@/components/supervisor/dashboard-attendance-overview';
import { DashboardTransactionsFeed } from '@/components/supervisor/dashboard-transactions-feed';
import { formatDate } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useSocketStore } from '@/stores/socket.store';
import { useCurrentShift, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useBranchInventoryAlerts, useInventoryRealtimeSync } from '@/hooks/queries/use-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';

const RECENT_TRANSACTIONS_LIMIT = 10;
const ATTENDANCE_OVERVIEW_LIMIT = 100;

export default function SupervisorDashboardPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const activeBranch = useBranchStore((s) => s.activeBranch);
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);

  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  useInventoryRealtimeSync(activeBranchId);
  useAttendanceRealtimeSync();

  // Calendar-day boundary, computed once on mount — deliberately not
  // reactive to clock ticking (the dashboard's attendance panel shows
  // "today so far", not a live-updating window).
  const [{ from, to }] = useState(() => {
    const now = new Date();
    return { from: startOfDay(now).toISOString(), to: now.toISOString() };
  });

  const { data: shift, isLoading: isShiftLoading } = useCurrentShift(activeBranchId);
  const { data: transactionsData, isLoading: isTransactionsLoading } = useTransactions({
    branch_id: activeBranchId ?? undefined,
    limit: RECENT_TRANSACTIONS_LIMIT,
  });
  const { data: alertsData, isLoading: isAlertsLoading } = useBranchInventoryAlerts(activeBranchId);
  const { data: attendanceData, isLoading: isAttendanceLoading } = useAttendanceByBranch(activeBranchId, {
    from,
    to,
    limit: ATTENDANCE_OVERVIEW_LIMIT,
  });

  if (!activeBranchId) {
    return (
      <EmptyState
        title="No branch configured"
        description="Select an active branch from the sidebar to view its dashboard."
      />
    );
  }

  const grossSales = shift ? shift.gross_sales_total : 0;
  const connectionLabel = isReconnecting ? 'Reconnecting' : isConnected ? 'Connected' : 'Disconnected';
  const connectionColor = isReconnecting ? 'bg-warning' : isConnected ? 'bg-success' : 'bg-destructive';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Branch Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {activeBranch?.name ?? activeBranchId} — {formatDate(new Date())}
          </p>
        </div>
        <span
          title={connectionLabel}
          aria-label={connectionLabel}
          className={`h-2.5 w-2.5 rounded-full ${connectionColor}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <DashboardShiftCard shift={shift} isLoading={isShiftLoading} />
        {isShiftLoading ? (
          <>
            <KpiCard title="Gross Sales" value={0} isLoading />
            <KpiCard title="Transactions" value={0} isLoading />
            <KpiCard title="Discounts Given" value={0} isLoading />
          </>
        ) : shift ? (
          <>
            <KpiCard title="Gross Sales" value={grossSales} prefix="₱" />
            <KpiCard title="Transactions" value={shift.transaction_count} />
            <KpiCard title="Discounts Given" value={shift.total_discount_amount} prefix="₱" />
          </>
        ) : (
          <>
            <KpiCard title="Gross Sales" value={0} prefix="₱" />
            <KpiCard title="Transactions" value={0} />
            <KpiCard title="Discounts Given" value={0} prefix="₱" />
          </>
        )}
      </div>

      <DashboardTransactionsFeed
        transactions={transactionsData?.transactions}
        isLoading={isTransactionsLoading}
        onRowClick={() => router.push('/supervisor/cash')}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardInventoryAlerts alerts={alertsData?.alerts} isLoading={isAlertsLoading} />
        <DashboardAttendanceOverview records={attendanceData?.records} isLoading={isAttendanceLoading} />
      </div>
    </div>
  );
}
