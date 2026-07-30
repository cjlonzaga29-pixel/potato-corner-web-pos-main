import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  grossSalesToday: number | undefined;
  grossSalesMonth: number | undefined;
  isLoadingToday: boolean;
  isLoadingMonth: boolean;
}

/**
 * Super admin dashboard's headline sales figures — Gross Sales Today and
 * Gross Sales This Month, per the slimmed-down dashboard spec. Pure display,
 * no data fetching.
 */
export function DashboardKpiRow({ grossSalesToday, grossSalesMonth, isLoadingToday, isLoadingMonth }: DashboardKpiRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <KpiCard title="Gross Sales Today" value={grossSalesToday ?? 0} prefix="₱" isLoading={isLoadingToday} emphasize />
      <KpiCard title="Gross Sales This Month" value={grossSalesMonth ?? 0} prefix="₱" isLoading={isLoadingMonth} emphasize />
    </div>
  );
}
