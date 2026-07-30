import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  activeShiftsCount: number | undefined;
  liveRevenue: number | undefined;
  flaggedShiftsCount: number | undefined;
  transactionsCount: number | undefined;
  activeCashiersCount: number | undefined;
  staffTimedInCount: number | undefined;
  lowStockCount: number | undefined;
  grossSales: number | undefined;
  netSales: number | undefined;
  expenses: number | undefined;
  netProfit: number | undefined;
  isNetProfitEstimated: boolean | undefined;
  isLoadingShifts: boolean;
  isLoadingRevenue: boolean;
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
  flaggedShiftsCount,
  transactionsCount,
  activeCashiersCount,
  staffTimedInCount,
  lowStockCount,
  grossSales,
  netSales,
  expenses,
  netProfit,
  isNetProfitEstimated,
  isLoadingShifts,
  isLoadingRevenue,
  isLoadingFlagged,
  isLoadingStats,
}: DashboardKpiRowProps) {
  const netProfitTitle = isNetProfitEstimated ? 'Estimated Net Profit' : 'Net Profit';
  const netProfitTooltip = isNetProfitEstimated
    ? 'Net Sales - COGS - Expenses. Estimated: cost data was missing for at least one sold item across accessible branches.'
    : 'Net Sales - COGS - Expenses';

  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Financial</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard title="Live Revenue (Open Shifts)" value={liveRevenue ?? 0} prefix="₱" isLoading={isLoadingRevenue} emphasize />
          <KpiCard title="Gross Sales" value={grossSales ?? 0} prefix="₱" isLoading={isLoadingStats} emphasize />
          <KpiCard title="Net Sales" value={netSales ?? 0} prefix="₱" isLoading={isLoadingStats} emphasize />
          <KpiCard title="Expenses" value={expenses ?? 0} prefix="₱" isLoading={isLoadingStats} emphasize />
          <KpiCard
            title={netProfitTitle}
            value={netProfit ?? 0}
            prefix="₱"
            isLoading={isLoadingStats}
            tone={(netProfit ?? 0) >= 0 ? 'positive' : 'negative'}
            tooltip={netProfitTooltip}
            emphasize
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Operational</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <KpiCard title="Active Shifts" value={activeShiftsCount ?? 0} isLoading={isLoadingShifts} />
          <KpiCard
            title="Flagged Shifts"
            value={flaggedShiftsCount ?? 0}
            isLoading={isLoadingFlagged}
            tone={(flaggedShiftsCount ?? 0) > 0 ? 'danger' : 'default'}
          />
          <KpiCard title="Transactions Today" value={transactionsCount ?? 0} isLoading={isLoadingStats} />
          <KpiCard title="Active Cashiers" value={activeCashiersCount ?? 0} isLoading={isLoadingStats} />
          <KpiCard title="Staff Timed In" value={staffTimedInCount ?? 0} isLoading={isLoadingStats} />
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
