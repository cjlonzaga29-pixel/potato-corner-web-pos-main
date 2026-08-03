import { Wallet, CalendarDays, Receipt, BadgeDollarSign } from 'lucide-react';
import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  grossSalesToday: number | undefined;
  grossSalesMonth: number | undefined;
  transactionsToday: number | undefined;
  averageOrderValue: number | undefined;
  isLoading: boolean;
}

/**
 * Super admin dashboard's primary KPI row — Gross Sales Today, Gross Sales
 * This Month, Today's Transactions, and Average Order Value, all aggregated
 * (summed) across every branch the admin's current branch filter covers
 * using the same `useAllBranchStats` figures the rest of the dashboard
 * already fetches. Pure display, no data fetching.
 *
 * TASK 165: Net Sales and (Estimated) Profit were removed from this row —
 * neither metric nor its calculation exists anywhere on the dashboard
 * anymore.
 */
export function DashboardKpiRow({ grossSalesToday, grossSalesMonth, transactionsToday, averageOrderValue, isLoading }: DashboardKpiRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        title="Gross Sales Today"
        value={grossSalesToday ?? 0}
        prefix="₱"
        isLoading={isLoading}
        icon={Wallet}
        emphasize
        tooltip="Completed sales for the selected Manila business day, across every branch in scope."
      />
      <KpiCard
        title="Gross Sales This Month"
        value={grossSalesMonth ?? 0}
        prefix="₱"
        isLoading={isLoading}
        icon={CalendarDays}
        tooltip="Completed sales for the current Manila calendar month, across every branch in scope."
      />
      <KpiCard title="Today's Transactions" value={transactionsToday ?? 0} isLoading={isLoading} icon={Receipt} />
      <KpiCard title="Average Order Value" value={averageOrderValue ?? 0} prefix="₱" isLoading={isLoading} icon={BadgeDollarSign} />
    </div>
  );
}
