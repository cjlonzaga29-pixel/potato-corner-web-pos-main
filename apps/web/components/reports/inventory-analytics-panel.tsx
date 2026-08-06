'use client';

import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartSkeleton } from '@/components/shared/charts/chart-skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { AreaChart } from '@/components/shared/charts/area-chart';
import { DataTable } from '@/components/shared/data-table/data-table';
import { MAX_LIST_LIMIT, type InventoryFastMover } from '@potato-corner/shared';
import { useInventoryAnalytics, useInventoryMovementReport } from '@/hooks/queries/use-reports';
import { manilaDaysAgo, manilaToday } from '@/lib/manila-date';

type Period = '7d' | '30d' | '90d' | '1yr';

interface InventoryAnalyticsPanelProps {
  branchId: string | null;
}

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90, '1yr': 365 };

const fastMoverColumns: ColumnDef<InventoryFastMover>[] = [
  { accessorKey: 'name', header: 'Ingredient' },
  { accessorKey: 'total_consumed', header: 'Total Consumed', cell: ({ row }) => `${row.original.total_consumed} ${row.original.unit}` },
  { accessorKey: 'avg_daily_consumption', header: 'Avg Daily Consumption', cell: ({ row }) => row.original.avg_daily_consumption.toFixed(2) },
];

const ADJUSTMENT_TYPE_LABEL: Record<string, string> = {
  waste: 'Spoilage / Waste',
  manual_adjustment: 'Manual Adjustment',
  physical_count: 'Physical Count Correction',
};

/**
 * Reports > Inventory Analytics tab — reuses the existing GET
 * /api/reports/inventory-analytics endpoint (fast movers, waste trends,
 * consumption cost summary) plus the existing INVENTORY_MOVEMENT report for
 * the adjustment-type breakdown, per the sprint's "reuse existing inventory
 * analytics logic" constraint. No new backend endpoints.
 */
export function InventoryAnalyticsPanel({ branchId }: InventoryAnalyticsPanelProps) {
  const [period, setPeriod] = useState<Period>('30d');
  const analytics = useInventoryAnalytics(branchId ?? undefined, period);
  const movements = useInventoryMovementReport(
    {
      branch_id: branchId ?? undefined,
      date_from: manilaDaysAgo(PERIOD_DAYS[period]),
      date_to: manilaToday(),
      page: 1,
      limit: MAX_LIST_LIMIT,
    },
    Boolean(branchId),
  );

  const isLoading = analytics.isLoading;
  const isError = analytics.isError;

  const topConsumed = useMemo(
    () => [...(analytics.data?.fast_movers ?? [])].sort((a, b) => b.total_consumed - a.total_consumed).slice(0, 10),
    [analytics.data],
  );

  const wasteTrendData = (analytics.data?.waste_trends ?? []).map((point) => ({
    date: point.date,
    waste_cost: point.total_waste_cost,
  }));

  const adjustmentBreakdown = useMemo(() => {
    const rows = movements.data?.data ?? [];
    const byType = new Map<string, number>();
    for (const row of rows) {
      if (row.movement_type === 'stock_in' || row.movement_type === 'sale_deduction') continue;
      byType.set(row.movement_type, (byType.get(row.movement_type) ?? 0) + 1);
    }
    return [...byType.entries()].map(([type, count]) => ({ type, label: ADJUSTMENT_TYPE_LABEL[type] ?? type, count }));
  }, [movements.data]);

  if (isError) {
    return <ErrorState retry={() => void analytics.refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 Days</SelectItem>
            <SelectItem value="30d">Last 30 Days</SelectItem>
            <SelectItem value="90d">Last 90 Days</SelectItem>
            <SelectItem value="1yr">Last Year</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiCard title="Inventory Cost Consumed" value={analytics.data?.summary.total_consumption_cost ?? 0} prefix="₱" isLoading={isLoading} />
        <KpiCard title="Waste Cost" value={analytics.data?.summary.total_waste_cost ?? 0} prefix="₱" isLoading={isLoading} tone="warning" />
        <KpiCard title="Avg Turnover Rate" value={analytics.data?.summary.avg_turnover_rate ?? 0} isLoading={isLoading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Daily Inventory Waste Cost</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <ChartSkeleton />
          ) : wasteTrendData.length === 0 ? (
            <EmptyState title="No data" description="There's nothing to chart yet." />
          ) : (
            <AreaChart
              data={wasteTrendData}
              areas={[{ dataKey: 'waste_cost', color: 'hsl(var(--destructive))', name: 'Waste Cost' }]}
              xAxisKey="date"
              animate={false}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Top Consumed Products</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={fastMoverColumns}
            data={topConsumed}
            isLoading={isLoading}
            emptyState={<EmptyState title="No consumption data" description="Nothing consumed in this period." />}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Inventory Adjustments</CardTitle>
        </CardHeader>
        <CardContent>
          {!branchId ? (
            <EmptyState title="Select a branch" description="Choose a branch above to see adjustment counts." />
          ) : movements.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : adjustmentBreakdown.length === 0 ? (
            <EmptyState title="No adjustments" description="No spoilage, expired, manual, or correction entries in this period." />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {adjustmentBreakdown.map((entry) => (
                <div key={entry.type} className="rounded-md border px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">{entry.label}</p>
                  <p className="text-lg font-semibold">{entry.count}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
