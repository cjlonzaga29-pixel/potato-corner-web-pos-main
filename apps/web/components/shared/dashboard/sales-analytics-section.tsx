'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { AreaChart } from '@/components/shared/charts/area-chart';
import { DonutChart } from '@/components/shared/charts/donut-chart';
import { CHART_PALETTE } from '@/components/shared/charts/chart-theme';
import {
  useDashboardSalesTrendReport,
  usePaymentMethodMixReport,
  useInventoryAnalytics,
  useReportsTrendsRealtimeSync,
  useInventoryAnalyticsRealtimeSync,
} from '@/hooks/queries/use-reports';
import { manilaToday, manilaDaysAgo } from '@/lib/manila-date';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

type Period = '7d' | '30d' | '90d';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 };
const PERIOD_LABEL: Record<Period, string> = { '7d': 'Last 7 Days', '30d': 'Last 30 Days', '90d': 'Last 90 Days' };

function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length] ?? CHART_PALETTE[0] ?? '#000000';
}

interface SalesAnalyticsSectionProps {
  /** undefined = org-wide (Admin, "All Branches"); a branch id scopes every query to that one branch. */
  branchId: string | undefined;
  /** Reuses the exact figures Reports > Inventory Analytics shows, so this tooltip names that as the source of truth. */
  inventoryCostTooltip?: string;
}

/**
 * "Sales Trend" + "Gross Sales vs Inventory Consumed" section, shared verbatim
 * across the Admin/Supervisor/Branch dashboards (spec: same source data, same
 * formula, no per-role recomputation). Built entirely from report endpoints
 * already used on the Reports page (DAILY_SALES, PAYMENT_METHOD_MIX,
 * INVENTORY_ANALYTICS) — no new backend routes.
 */
export function SalesAnalyticsSection({ branchId, inventoryCostTooltip }: SalesAnalyticsSectionProps) {
  const [period, setPeriod] = useState<Period>('7d');
  useReportsTrendsRealtimeSync();
  useInventoryAnalyticsRealtimeSync();

  const filters = {
    branch_id: branchId,
    date_from: manilaDaysAgo(PERIOD_DAYS[period]),
    date_to: manilaToday(),
    page: 1,
    limit: MAX_LIST_LIMIT,
  };
  const salesTrend = useDashboardSalesTrendReport(filters);
  const paymentMix = usePaymentMethodMixReport(filters);
  const inventoryAnalytics = useInventoryAnalytics(branchId, period);

  const isLoading = salesTrend.isLoading || paymentMix.isLoading || inventoryAnalytics.isLoading;
  const isError = salesTrend.isError || paymentMix.isError || inventoryAnalytics.isError;

  const trendData = useMemo(
    () =>
      [...(salesTrend.data?.data ?? [])]
        .sort((a, b) => a.report_date.localeCompare(b.report_date))
        .map((row) => ({ report_date: row.report_date, gross_sales: row.gross_sales })),
    [salesTrend.data],
  );

  const grossSales = useMemo(() => trendData.reduce((sum, row) => sum + row.gross_sales, 0), [trendData]);
  const inventoryCostConsumed = inventoryAnalytics.data?.summary.total_consumption_cost ?? 0;

  const paymentBreakdownData = (paymentMix.data ?? []).map((row, index) => ({
    name: row.payment_method,
    value: row.total_amount,
    color: paletteColor(index),
  }));

  if (isError) {
    return (
      <ErrorState
        retry={() => {
          void salesTrend.refetch();
          void paymentMix.refetch();
          void inventoryAnalytics.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sales Trend</h2>
        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <KpiCard title="Gross Sales" value={grossSales} prefix="₱" isLoading={isLoading} emphasize />
        <KpiCard
          title="Inventory Cost Consumed"
          value={inventoryCostConsumed}
          prefix="₱"
          isLoading={isLoading}
          emphasize
          tone="warning"
          tooltip={inventoryCostTooltip ?? 'Same figure as Reports > Inventory Analytics for this branch and period.'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Gross Sales ({PERIOD_LABEL[period]})</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-[300px] w-full" /> : (
              <AreaChart
                data={trendData}
                areas={[{ dataKey: 'gross_sales', color: paletteColor(0), name: 'Gross Sales' }]}
                xAxisKey="report_date"
                animate={false}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Payment Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-[300px] w-full" /> : <DonutChart data={paymentBreakdownData} animate={false} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
