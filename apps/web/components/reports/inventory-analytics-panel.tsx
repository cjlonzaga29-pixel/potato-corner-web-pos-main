'use client';

import { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import type {
  InventoryFastMover,
  InventorySlowMover,
  InventoryReorderRecommendation,
} from '@potato-corner/shared';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { LineChart } from '@/components/shared/charts/line-chart';
import { BarChart } from '@/components/shared/charts/bar-chart';
import { useBranches } from '@/hooks/queries/use-branches';
import { useInventoryAnalytics, type InventoryAnalyticsPeriod } from '@/hooks/queries/use-inventory-analytics';

const ALL_BRANCHES = 'all';
const DEFAULT_PERIOD: InventoryAnalyticsPeriod = '30d';
const PERIOD_OPTIONS: { value: InventoryAnalyticsPeriod; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '1yr', label: 'Last year' },
];

const fastMoverColumns: ColumnDef<InventoryFastMover>[] = [
  { accessorKey: 'name', header: 'Ingredient' },
  { accessorKey: 'unit', header: 'Unit' },
  { accessorKey: 'total_consumed', header: 'Qty Consumed' },
  { accessorKey: 'avg_daily_consumption', header: 'Avg Daily' },
];

const slowMoverColumns: ColumnDef<InventorySlowMover>[] = [
  { accessorKey: 'name', header: 'Ingredient' },
  { accessorKey: 'unit', header: 'Unit' },
  { accessorKey: 'total_consumed', header: 'Qty Consumed' },
  {
    accessorKey: 'days_since_last_movement',
    header: 'Days Since Last Movement',
    cell: ({ row }) => row.original.days_since_last_movement ?? '—',
  },
];

const reorderColumns: ColumnDef<InventoryReorderRecommendation>[] = [
  { accessorKey: 'name', header: 'Ingredient' },
  { accessorKey: 'current_stock', header: 'Current Stock' },
  {
    accessorKey: 'days_until_stockout',
    header: 'Days Until Stockout',
    cell: ({ row }) => row.original.days_until_stockout ?? '—',
  },
  { accessorKey: 'recommended_reorder_qty', header: 'Recommended Reorder Qty' },
];

function InventoryAnalyticsPanelContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const branchId = searchParams.get('inv_branch_id') ?? ALL_BRANCHES;
  const period = (searchParams.get('inv_period') as InventoryAnalyticsPeriod | null) ?? DEFAULT_PERIOD;

  function pushParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === ALL_BRANCHES) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  const { data, isLoading, isError, refetch } = useInventoryAnalytics({
    branchId: branchId === ALL_BRANCHES ? undefined : branchId,
    period,
  });

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">Fast/Slow Movers, Waste &amp; Reorder Recommendations</h3>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="inventory-analytics-branch-filter">Branch</Label>
          <Select value={branchId} onValueChange={(value) => pushParams({ inv_branch_id: value })}>
            <SelectTrigger id="inventory-analytics-branch-filter" className="w-[220px]" disabled={isBranchesLoading}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="inventory-analytics-period-filter">Period</Label>
          <Select value={period} onValueChange={(value) => pushParams({ inv_period: value })}>
            <SelectTrigger id="inventory-analytics-period-filter" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError ? (
        <ErrorState retry={() => void refetch()} />
      ) : isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Movements" value={data?.summary.total_movements ?? 0} />
            <KpiCard title="Total Waste Cost" value={data?.summary.total_waste_cost ?? 0} prefix="₱" tone="warning" />
            <KpiCard title="Total Consumption Cost" value={data?.summary.total_consumption_cost ?? 0} prefix="₱" />
            <KpiCard title="Avg Turnover Rate" value={data?.summary.avg_turnover_rate ?? 0} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h4 className="mb-2 text-sm font-semibold">Fast Movers</h4>
              <DataTable
                columns={fastMoverColumns}
                data={data?.fast_movers ?? []}
                emptyState={<EmptyState title="No consumption in this period" />}
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">Slow Movers</h4>
              <DataTable
                columns={slowMoverColumns}
                data={data?.slow_movers ?? []}
                emptyState={<EmptyState title="No consumption in this period" />}
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">Waste Trends</h4>
              <LineChart
                data={(data?.waste_trends ?? []).map((w) => ({ date: w.date, total_waste_cost: w.total_waste_cost }))}
                lines={[{ dataKey: 'total_waste_cost', color: '#ef4444', name: 'Waste Cost' }]}
                xAxisKey="date"
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">Turnover by Branch</h4>
              <BarChart
                data={(data?.turnover_by_branch ?? []).map((t) => ({ branch_name: t.branch_name, turnover_rate: t.turnover_rate }))}
                bars={[{ dataKey: 'turnover_rate', color: '#3b82f6', name: 'Turnover Rate' }]}
                xAxisKey="branch_name"
              />
            </div>

            <div className="lg:col-span-2">
              <h4 className="mb-2 text-sm font-semibold">Reorder Recommendations</h4>
              <DataTable
                columns={reorderColumns}
                data={data?.reorder_recommendations ?? []}
                emptyState={<EmptyState title="No ingredients need reordering" />}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function InventoryAnalyticsPanel() {
  return (
    <Suspense fallback={<div>Loading inventory analytics...</div>}>
      <InventoryAnalyticsPanelContent />
    </Suspense>
  );
}
