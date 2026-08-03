import { Wallet, Banknote, Receipt, TrendingUp } from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  grossSalesToday: number | undefined;
  netSalesToday: number | undefined;
  transactionsToday: number | undefined;
  profitToday: number | undefined;
  isProfitEstimated: boolean;
  missingCostItemCount: number;
  isLoading: boolean;
}

/**
 * Super admin dashboard's primary KPI row — Gross Sales, Net Sales,
 * Transactions, and Estimated Profit, all aggregated (summed) across every
 * branch the admin's current branch filter covers using the same
 * `useAllBranchStats` figures the rest of the dashboard already fetches.
 * Pure display, no data fetching.
 */
export function DashboardKpiRow({
  grossSalesToday,
  netSalesToday,
  transactionsToday,
  profitToday,
  isProfitEstimated,
  missingCostItemCount,
  isLoading,
}: DashboardKpiRowProps) {
  const profitLabel = isProfitEstimated ? 'Estimated Profit Today' : 'Profit Today';
  const profitTooltip = isProfitEstimated
    ? `Net Sales - COGS - Expenses. Cost data was missing for ${missingCostItemCount} sold item(s) across branches, so this figure is an estimate.`
    : 'Net Sales - COGS - Expenses';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        title="Gross Sales"
        value={grossSalesToday ?? 0}
        prefix="₱"
        isLoading={isLoading}
        icon={Wallet}
        emphasize
        tooltip="Completed sales for the selected Manila business day, across every branch in scope."
      />
      <KpiCard
        title="Net Sales"
        value={netSalesToday ?? 0}
        prefix="₱"
        isLoading={isLoading}
        icon={Banknote}
        tooltip="Gross Sales minus discounts and refunds."
      />
      <KpiCard title="Transactions" value={transactionsToday ?? 0} isLoading={isLoading} icon={Receipt} />
      <KpiCard
        title={profitLabel}
        value={profitToday ?? 0}
        prefix="₱"
        isLoading={isLoading}
        icon={TrendingUp}
        tone={(profitToday ?? 0) < 0 ? 'negative' : 'default'}
        tooltip={profitTooltip}
      />
    </div>
  );
}
