'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { AreaChart } from '@/components/shared/charts/area-chart';
import { BarChart } from '@/components/shared/charts/bar-chart';
import { DonutChart } from '@/components/shared/charts/donut-chart';
import { CHART_PALETTE } from '@/components/shared/charts/chart-theme';
import {
  useDashboardSalesTrendReport,
  useBranchComparisonReport,
  useDashboardProductPerformanceReport,
  usePaymentMethodMixReport,
  useDashboardDiscountMixReport,
  useReportsTrendsRealtimeSync,
} from '@/hooks/queries/use-reports';

const TREND_RANGE_DAYS = 30;
const TOP_PRODUCT_COUNT = 6;

function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length] ?? CHART_PALETTE[0] ?? '#000000';
}

function daysAgoDateString(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ChartCardProps {
  title: string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  isEmpty: boolean;
  children: React.ReactNode;
}

function ChartCard({ title, isLoading, isError, onRetry, isEmpty, children }: ChartCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <ErrorState retry={onRetry} />
        ) : isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : isEmpty ? (
          <EmptyState title="No data" description="There's nothing to chart yet." />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

interface DashboardTrendsSectionProps {
  branchFilter: string | undefined;
}

/** "Trends & Analytics" section on the Super Admin dashboard — sits between the KPI row and the pending-items grid. */
export function DashboardTrendsSection({ branchFilter }: DashboardTrendsSectionProps) {
  useReportsTrendsRealtimeSync();

  const dateFilters = { date_from: daysAgoDateString(TREND_RANGE_DAYS), date_to: todayDateString(), page: 1, limit: 100 };

  const salesTrend = useDashboardSalesTrendReport({ ...dateFilters, branch_id: branchFilter });
  const branchComparison = useBranchComparisonReport(undefined, branchFilter === undefined);
  const productPerformance = useDashboardProductPerformanceReport(branchFilter);
  const paymentMethodMix = usePaymentMethodMixReport({ ...dateFilters, branch_id: branchFilter });
  const discountMix = useDashboardDiscountMixReport({ ...dateFilters, branch_id: branchFilter });

  const salesTrendData = (() => {
    const rows = salesTrend.data?.data ?? [];
    const byDate = new Map<string, { report_date: string; gross_sales: number; net_sales: number }>();
    for (const row of rows) {
      const existing = byDate.get(row.report_date) ?? { report_date: row.report_date, gross_sales: 0, net_sales: 0 };
      existing.gross_sales += row.gross_sales;
      existing.net_sales += row.net_sales;
      byDate.set(row.report_date, existing);
    }
    return [...byDate.values()].sort((a, b) => a.report_date.localeCompare(b.report_date));
  })();

  const branchComparisonData = (branchComparison.data?.data ?? []).map((row) => ({
    branch_name: row.branch_name,
    gross_sales: row.gross_sales,
  }));

  const topProductsData = (() => {
    const rows = [...(productPerformance.data?.data ?? [])].sort((a, b) => b.gross_revenue - a.gross_revenue);
    const top = rows.slice(0, TOP_PRODUCT_COUNT);
    const otherTotal = rows.slice(TOP_PRODUCT_COUNT).reduce((sum, row) => sum + row.gross_revenue, 0);
    const entries = top.map((row, index) => ({
      name: row.product_name,
      value: row.gross_revenue,
      color: paletteColor(index),
    }));
    if (otherTotal > 0) entries.push({ name: 'Other', value: otherTotal, color: paletteColor(TOP_PRODUCT_COUNT) });
    return entries;
  })();

  const paymentMethodData = (paymentMethodMix.data ?? []).map((row, index) => ({
    name: row.payment_method,
    value: row.total_amount,
    color: paletteColor(index),
  }));

  const discountMixData = (() => {
    const rows = discountMix.data?.data ?? [];
    const byType = new Map<string, number>();
    for (const row of rows) byType.set(row.discount_type, (byType.get(row.discount_type) ?? 0) + row.total_discount_amount);
    return [...byType.entries()].map(([name, value], index) => ({ name, value, color: paletteColor(index) }));
  })();

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Trends &amp; Analytics</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <ChartCard
            title="Sales Trend (Last 30 Days)"
            isLoading={salesTrend.isLoading}
            isError={salesTrend.isError}
            onRetry={() => void salesTrend.refetch()}
            isEmpty={salesTrendData.length === 0}
          >
            <AreaChart
              data={salesTrendData}
              areas={[
                { dataKey: 'gross_sales', color: paletteColor(0), name: 'Gross Sales' },
                { dataKey: 'net_sales', color: paletteColor(1), name: 'Net Sales' },
              ]}
              xAxisKey="report_date"
              animate={false}
            />
          </ChartCard>
        </div>

        {branchFilter === undefined && (
          <div className="lg:col-span-2">
            <ChartCard
              title="Branch Comparison"
              isLoading={branchComparison.isLoading}
              isError={branchComparison.isError}
              onRetry={() => void branchComparison.refetch()}
              isEmpty={branchComparisonData.length === 0}
            >
              <BarChart
                data={branchComparisonData}
                bars={[{ dataKey: 'gross_sales', color: paletteColor(0), name: 'Gross Sales' }]}
                xAxisKey="branch_name"
                animate={false}
              />
            </ChartCard>
          </div>
        )}

        <ChartCard
          title="Top Products by Revenue"
          isLoading={productPerformance.isLoading}
          isError={productPerformance.isError}
          onRetry={() => void productPerformance.refetch()}
          isEmpty={topProductsData.length === 0}
        >
          <DonutChart data={topProductsData} animate={false} />
        </ChartCard>

        <ChartCard
          title="Payment Method Split"
          isLoading={paymentMethodMix.isLoading}
          isError={paymentMethodMix.isError}
          onRetry={() => void paymentMethodMix.refetch()}
          isEmpty={paymentMethodData.length === 0}
        >
          <DonutChart data={paymentMethodData} animate={false} />
        </ChartCard>

        <ChartCard
          title="Discount Type Mix"
          isLoading={discountMix.isLoading}
          isError={discountMix.isError}
          onRetry={() => void discountMix.refetch()}
          isEmpty={discountMixData.length === 0}
        >
          <DonutChart data={discountMixData} animate={false} />
        </ChartCard>
      </div>
    </div>
  );
}
