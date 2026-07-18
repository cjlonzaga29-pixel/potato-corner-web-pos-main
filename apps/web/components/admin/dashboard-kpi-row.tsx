import { KpiCard } from '@/components/shared/charts/kpi-card';

interface DashboardKpiRowProps {
  activeShiftsCount: number | undefined;
  liveRevenue: number | undefined;
  pendingApprovalsCount: number | undefined;
  flaggedShiftsCount: number | undefined;
  isLoadingShifts: boolean;
  isLoadingRevenue: boolean;
  isLoadingApprovals: boolean;
  isLoadingFlagged: boolean;
}

/** Row 1 of the super admin dashboard — 4 independent KPIs, each with its own loading state so one slow query never blocks the others. Pure display, no data fetching. */
export function DashboardKpiRow({
  activeShiftsCount,
  liveRevenue,
  pendingApprovalsCount,
  flaggedShiftsCount,
  isLoadingShifts,
  isLoadingRevenue,
  isLoadingApprovals,
  isLoadingFlagged,
}: DashboardKpiRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
      <KpiCard title="Active Shifts" value={activeShiftsCount ?? 0} isLoading={isLoadingShifts} />
      <KpiCard title="Live Revenue (Open Shifts)" value={liveRevenue ?? 0} prefix="₱" isLoading={isLoadingRevenue} />
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
    </div>
  );
}
