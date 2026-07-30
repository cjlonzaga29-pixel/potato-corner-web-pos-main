'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { AreaChart } from '@/components/shared/charts/area-chart';
import { DonutChart } from '@/components/shared/charts/donut-chart';
import { CHART_PALETTE } from '@/components/shared/charts/chart-theme';
import { useExpenses } from '@/hooks/queries/use-expenses';
import { useDashboardSalesTrendReport, usePaymentMethodMixReport } from '@/hooks/queries/use-reports';
import { MAX_LIST_LIMIT } from '@potato-corner/shared';

type Granularity = 'daily' | 'weekly' | 'monthly';

interface FinancialSummaryPanelProps {
  branchId: string | null;
  dateFrom: string;
  dateTo: string;
}

function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length] ?? CHART_PALETTE[0] ?? '#000000';
}

/** ISO week (Mon-Sun) bucket key, e.g. "2026-W31", for grouping daily rows into weekly points. */
function isoWeekKey(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function bucketKey(dateStr: string, granularity: Granularity): string {
  if (granularity === 'monthly') return monthKey(dateStr);
  if (granularity === 'weekly') return isoWeekKey(dateStr);
  return dateStr;
}

/**
 * Reports > Financial Summary tab — org-wide (or branch-scoped) Gross Sales,
 * Expenses, Net Income, Payment Breakdown, and a Daily/Weekly/Monthly sales
 * trend chart. Reuses the existing DAILY_SALES, payment-method-mix, and
 * expenses endpoints rather than adding new report queries.
 */
export function FinancialSummaryPanel({ branchId, dateFrom, dateTo }: FinancialSummaryPanelProps) {
  const [granularity, setGranularity] = useState<Granularity>('daily');

  const filters = { branch_id: branchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: MAX_LIST_LIMIT };
  const salesTrend = useDashboardSalesTrendReport(filters);
  const paymentMix = usePaymentMethodMixReport(filters);
  const expenses = useExpenses(filters);

  const isLoading = salesTrend.isLoading || paymentMix.isLoading || expenses.isLoading;
  const isError = salesTrend.isError || paymentMix.isError || expenses.isError;

  const grossSales = useMemo(() => (salesTrend.data?.data ?? []).reduce((sum, row) => sum + row.gross_sales, 0), [salesTrend.data]);
  const totalExpenses = expenses.data?.total_amount ?? 0;
  const netIncome = grossSales - totalExpenses;

  const trendData = useMemo(() => {
    const rows = salesTrend.data?.data ?? [];
    const buckets = new Map<string, { bucket: string; gross_sales: number; net_sales: number }>();
    for (const row of rows) {
      const key = bucketKey(row.report_date, granularity);
      const existing = buckets.get(key) ?? { bucket: key, gross_sales: 0, net_sales: 0 };
      existing.gross_sales += row.gross_sales;
      existing.net_sales += row.net_sales;
      buckets.set(key, existing);
    }
    return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [salesTrend.data, granularity]);

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
          void expenses.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiCard title="Gross Sales" value={grossSales} prefix="₱" isLoading={isLoading} emphasize />
        <KpiCard title="Expenses" value={totalExpenses} prefix="₱" isLoading={isLoading} emphasize />
        <KpiCard
          title="Net Income"
          value={netIncome}
          prefix="₱"
          isLoading={isLoading}
          tone={netIncome >= 0 ? 'positive' : 'negative'}
          tooltip="Gross Sales minus Expenses for the selected range (COGS not included)."
          emphasize
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-medium">Sales Trend</CardTitle>
            <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : trendData.length === 0 ? (
              <EmptyState title="No data" description="There's nothing to chart yet." />
            ) : (
              <AreaChart
                data={trendData}
                areas={[
                  { dataKey: 'gross_sales', color: paletteColor(0), name: 'Gross Sales' },
                  { dataKey: 'net_sales', color: paletteColor(1), name: 'Net Sales' },
                ]}
                xAxisKey="bucket"
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
            {isLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : paymentBreakdownData.length === 0 ? (
              <EmptyState title="No data" description="There's nothing to chart yet." />
            ) : (
              <DonutChart data={paymentBreakdownData} animate={false} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
