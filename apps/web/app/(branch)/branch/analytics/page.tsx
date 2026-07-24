'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type {
  EmployeePerformanceReportRow,
  FlavorPerformanceReportRow,
  InventoryValuationReportRow,
  ProductPerformanceReportRow,
} from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency, formatDuration } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import {
  useProductPerformanceReport,
  useFlavorPerformanceReport,
  useEmployeePerformanceReport,
  useInventoryValuationReport,
  useInventoryAnalytics,
} from '@/hooks/queries/use-reports';

const productColumns: ColumnDef<ProductPerformanceReportRow>[] = [
  { id: 'product_name', header: 'Product', accessorKey: 'product_name' },
  { id: 'variant_name', header: 'Variant', accessorKey: 'variant_name' },
  { id: 'units_sold', header: 'Units Sold', accessorKey: 'units_sold' },
  { id: 'transaction_count', header: 'Transactions', accessorKey: 'transaction_count' },
  { id: 'gross_revenue', header: 'Gross Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

const flavorColumns: ColumnDef<FlavorPerformanceReportRow>[] = [
  { id: 'flavor_name', header: 'Flavor', accessorKey: 'flavor_name' },
  { id: 'units_sold', header: 'Units Sold', accessorKey: 'units_sold' },
  { id: 'gross_revenue', header: 'Gross Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

const employeeColumns: ColumnDef<EmployeePerformanceReportRow>[] = [
  { id: 'employee_name', header: 'Employee', accessorKey: 'employee_name' },
  { id: 'transaction_count', header: 'Transactions', accessorKey: 'transaction_count' },
  { id: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
  { id: 'hours_worked', header: 'Hours Worked', cell: ({ row }) => formatDuration(row.original.hours_worked * 60) },
];

const valuationColumns: ColumnDef<InventoryValuationReportRow>[] = [
  { id: 'ingredient_name', header: 'Ingredient', accessorKey: 'ingredient_name' },
  {
    id: 'current_stock',
    header: 'Current Stock',
    cell: ({ row }) => `${row.original.current_stock} ${row.original.unit}`,
  },
  {
    id: 'unit_cost',
    header: 'Unit Cost',
    cell: ({ row }) => (row.original.unit_cost !== null ? formatCurrency(row.original.unit_cost) : '—'),
  },
  { id: 'total_value', header: 'Total Value', cell: ({ row }) => formatCurrency(row.original.total_value) },
  { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="inventory" /> },
];

/**
 * Branch-scoped analytics — Product/Flavor/Employee Performance and
 * Inventory Valuation are all precomputed report endpoints
 * (adminSupervisorOrBranch, GET /api/reports/*) that already existed but had
 * no consumer anywhere in the app; Inventory Analytics (fast/slow movers,
 * waste trend, reorder recommendations) is likewise a real, previously-
 * unwired endpoint. No fabricated data — every tab here is a thin view over
 * an endpoint the backend has supported since Phase 16 / Step 10.
 */
export default function BranchAnalyticsPage() {
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const [period, setPeriod] = useState<'7d' | '30d' | '90d' | '1yr'>('30d');

  const productPerformance = useProductPerformanceReport(branchId, Boolean(branchId));
  const flavorPerformance = useFlavorPerformanceReport(branchId, Boolean(branchId));
  const employeePerformance = useEmployeePerformanceReport(branchId, Boolean(branchId));
  const inventoryValuation = useInventoryValuationReport(branchId, Boolean(branchId));
  const inventoryAnalytics = useInventoryAnalytics(branchId, period, Boolean(branchId));

  if (!branchId) {
    return <EmptyState title="No branch assigned" description="Contact your supervisor to get staffed to a branch." />;
  }

  const analytics = inventoryAnalytics.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-sm text-muted-foreground">Performance and inventory analytics for your branch.</p>
      </div>

      <Tabs defaultValue="product-performance" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="product-performance">Product Performance</TabsTrigger>
          <TabsTrigger value="flavor-performance">Flavor Performance</TabsTrigger>
          <TabsTrigger value="employee-performance">Employee Performance</TabsTrigger>
          <TabsTrigger value="inventory-valuation">Inventory Valuation</TabsTrigger>
          <TabsTrigger value="inventory-analytics">Inventory Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="product-performance" className="space-y-4">
          <DataTable
            columns={productColumns}
            data={productPerformance.data?.data ?? []}
            isLoading={productPerformance.isLoading}
            isError={productPerformance.isError}
            onRetry={() => void productPerformance.refetch()}
            emptyState={<EmptyState title="No sales data yet" description="Product performance will appear once sales are recorded." />}
          />
        </TabsContent>

        <TabsContent value="flavor-performance" className="space-y-4">
          <DataTable
            columns={flavorColumns}
            data={flavorPerformance.data?.data ?? []}
            isLoading={flavorPerformance.isLoading}
            isError={flavorPerformance.isError}
            onRetry={() => void flavorPerformance.refetch()}
            emptyState={<EmptyState title="No flavor sales yet" description="Flavor performance will appear once sales are recorded." />}
          />
        </TabsContent>

        <TabsContent value="employee-performance" className="space-y-4">
          <DataTable
            columns={employeeColumns}
            data={employeePerformance.data?.data ?? []}
            isLoading={employeePerformance.isLoading}
            isError={employeePerformance.isError}
            onRetry={() => void employeePerformance.refetch()}
            emptyState={<EmptyState title="No employee activity yet" description="Employee performance will appear once shifts are worked." />}
          />
        </TabsContent>

        <TabsContent value="inventory-valuation" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <KpiCard
              title="Total Inventory Value"
              value={(inventoryValuation.data?.data ?? []).reduce((sum, r) => sum + r.total_value, 0)}
              prefix="₱"
              isLoading={inventoryValuation.isLoading}
            />
            <KpiCard
              title="Low/Critical Ingredients"
              value={(inventoryValuation.data?.data ?? []).filter((r) => r.status !== 'ok').length}
              isLoading={inventoryValuation.isLoading}
              tone="warning"
            />
          </div>
          <DataTable
            columns={valuationColumns}
            data={inventoryValuation.data?.data ?? []}
            isLoading={inventoryValuation.isLoading}
            isError={inventoryValuation.isError}
            onRetry={() => void inventoryValuation.refetch()}
            emptyState={<EmptyState title="No ingredients yet" description="Inventory valuation will appear once ingredients are stocked." />}
          />
        </TabsContent>

        <TabsContent value="inventory-analytics" className="space-y-4">
          <div className="flex justify-end">
            <Select value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
                <SelectItem value="1yr">Last year</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {inventoryAnalytics.isError ? (
            <EmptyState title="Failed to load inventory analytics" description="Try refreshing the page." />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                <KpiCard title="Total Movements" value={analytics?.summary.total_movements ?? 0} isLoading={inventoryAnalytics.isLoading} />
                <KpiCard title="Waste Cost" value={analytics?.summary.total_waste_cost ?? 0} prefix="₱" isLoading={inventoryAnalytics.isLoading} tone="warning" />
                <KpiCard title="Consumption Cost" value={analytics?.summary.total_consumption_cost ?? 0} prefix="₱" isLoading={inventoryAnalytics.isLoading} />
                <KpiCard title="Avg Turnover Rate" value={analytics?.summary.avg_turnover_rate ?? 0} isLoading={inventoryAnalytics.isLoading} />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="space-y-2 rounded-md border p-3">
                  <p className="font-medium">Fast Movers</p>
                  {analytics && analytics.fast_movers.length > 0 ? (
                    <ul className="space-y-1 text-sm">
                      {analytics.fast_movers.map((m) => (
                        <li key={m.ingredient_id} className="flex justify-between">
                          <span>{m.name}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {m.avg_daily_consumption.toFixed(1)} {m.unit}/day
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No fast-moving ingredients in this period.</p>
                  )}
                </div>

                <div className="space-y-2 rounded-md border p-3">
                  <p className="font-medium">Slow Movers</p>
                  {analytics && analytics.slow_movers.length > 0 ? (
                    <ul className="space-y-1 text-sm">
                      {analytics.slow_movers.map((m) => (
                        <li key={m.ingredient_id} className="flex justify-between">
                          <span>{m.name}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {m.days_since_last_movement !== null ? `${m.days_since_last_movement}d idle` : 'never moved'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No slow-moving ingredients in this period.</p>
                  )}
                </div>
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <p className="font-medium">Reorder Recommendations</p>
                {analytics && analytics.reorder_recommendations.length > 0 ? (
                  <ul className="space-y-1 text-sm">
                    {analytics.reorder_recommendations.map((r) => (
                      <li key={r.ingredient_id} className="flex justify-between">
                        <span>{r.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {r.days_until_stockout !== null ? `${r.days_until_stockout}d until stockout` : '—'} · reorder{' '}
                          {r.recommended_reorder_qty}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No reorder recommendations right now.</p>
                )}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
