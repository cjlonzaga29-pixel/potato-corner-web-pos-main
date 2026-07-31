import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  grossSalesToday: number | undefined;
  grossSalesMonth: number | undefined;
  isLoadingToday: boolean;
  isLoadingMonth: boolean;
}

/**
 * Super admin dashboard's headline sales figures — Daily Gross Sales and
 * Monthly Gross Sales, per the slimmed-down dashboard spec. Pure display,
 * no data fetching.
 */
export function DashboardKpiRow({ grossSalesToday, grossSalesMonth, isLoadingToday, isLoadingMonth }: DashboardKpiRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <KpiCard
        title="Daily Gross Sales"
        value={grossSalesToday ?? 0}
        prefix="₱"
        isLoading={isLoadingToday}
        emphasize
        tooltip="Completed sales for the selected Manila business day."
      />
      <KpiCard
        title="Monthly Gross Sales"
        value={grossSalesMonth ?? 0}
        prefix="₱"
        isLoading={isLoadingMonth}
        emphasize
        tooltip="Completed sales for the current Manila calendar month."
      />
    </div>
  );
}
