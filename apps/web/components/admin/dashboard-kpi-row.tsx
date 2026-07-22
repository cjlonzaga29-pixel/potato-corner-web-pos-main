import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  activeShiftsCount: number | undefined;
  liveRevenue: number | undefined;
  pendingApprovalsCount: number | undefined;
  flaggedShiftsCount: number | undefined;
  transactionsCount: number | undefined;
  activeCashiersCount: number | undefined;
  lowStockCount: number | undefined;
  grossSales: number | undefined;
  expenses: number | undefined;
  netProfit: number | undefined;
  isLoadingShifts: boolean;
  isLoadingRevenue: boolean;
  isLoadingApprovals: boolean;
  isLoadingFlagged: boolean;
  isLoadingStats: boolean;
}

/**
 * Super admin dashboard's KPI grid — 10 independent KPIs across two visually
 * grouped sections, each with its own loading state so one slow query never
 * blocks the others. Pure display, no data fetching.
 */
export function DashboardKpiRow({
  activeShiftsCount,
  liveRevenue,
  pendingApprovalsCount,
  flaggedShiftsCount,
  transactionsCount,
  activeCashiersCount,
  lowStockCount,
  grossSales,
  expenses,
  netProfit,
  isLoadingShifts,
  isLoadingRevenue,
  isLoadingApprovals,
  isLoadingFlagged,
  isLoadingStats,
}: DashboardKpiRowProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Financial</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
          <KpiCard title="Live Revenue (Open Shifts)" value={liveRevenue ?? 0} prefix="₱" isLoading={isLoadingRevenue} />
          <KpiCard title="Gross Sales" value={grossSales ?? 0} prefix="₱" isLoading={isLoadingStats} />
          <KpiCard title="Expenses" value={expenses ?? 0} prefix="₱" isLoading={isLoadingStats} />
          <KpiCard
            title="Net Profit"
            value={netProfit ?? 0}
            prefix="₱"
            isLoading={isLoadingStats}
            tone={(netProfit ?? 0) >= 0 ? 'positive' : 'negative'}
            tooltip="Gross Sales - VAT - Expenses"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Operational</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <KpiCard title="Active Shifts" value={activeShiftsCount ?? 0} isLoading={isLoadingShifts} />
          <KpiCard
            title="Pending Approvals"
            value={pendingApprovalsCount ?? 0}
            isLoading={isLoadingApprovals}
            tone={(pendingApprovalsCount ?? 0) > 0 ? 'warning' : 'default'}
          />
          <KpiCard
            title="Flagged Shifts"
            value={flaggedShiftsCount ?? 0}
            isLoading={isLoadingFlagged}
            tone={(flaggedShiftsCount ?? 0) > 0 ? 'danger' : 'default'}
          />
          <KpiCard title="Transactions Today" value={transactionsCount ?? 0} isLoading={isLoadingStats} />
          <KpiCard title="Active Cashiers" value={activeCashiersCount ?? 0} isLoading={isLoadingStats} />
          <KpiCard
            title="Low Stock"
            value={lowStockCount ?? 0}
            isLoading={isLoadingStats}
            tone={(lowStockCount ?? 0) > 0 ? 'warning' : 'default'}
          />
        </div>
      </div>
    </div>
  );
}
