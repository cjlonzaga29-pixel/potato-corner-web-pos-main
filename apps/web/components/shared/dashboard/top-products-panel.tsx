'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { ProductPerformanceReportRow } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { formatCurrency } from '@/lib/utils';
import { useDashboardProductPerformanceReport } from '@/hooks/queries/use-reports';

const TOP_PRODUCT_COUNT = 5;

const columns: ColumnDef<ProductPerformanceReportRow>[] = [
  { accessorKey: 'product_name', header: 'Product' },
  { accessorKey: 'variant_name', header: 'Variant' },
  { accessorKey: 'units_sold', header: 'Units Sold' },
  { accessorKey: 'gross_revenue', header: 'Revenue', cell: ({ row }) => formatCurrency(row.original.gross_revenue) },
];

interface TopProductsPanelProps {
  /** undefined = org-wide (Admin); a branch id scopes to that branch's sales (Supervisor/Branch). */
  branchId: string | undefined;
}

/** Reuses the same PRODUCT_PERFORMANCE snapshot Reports > (legacy) product reports read — no new query. */
export function TopProductsPanel({ branchId }: TopProductsPanelProps) {
  const productPerformance = useDashboardProductPerformanceReport(branchId);

  const topProducts = useMemo(
    () => [...(productPerformance.data?.data ?? [])].sort((a, b) => b.gross_revenue - a.gross_revenue).slice(0, TOP_PRODUCT_COUNT),
    [productPerformance.data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top Products</CardTitle>
      </CardHeader>
      <CardContent>
        {productPerformance.isError ? (
          <ErrorState retry={() => void productPerformance.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={topProducts}
            isLoading={productPerformance.isLoading}
            emptyState={<EmptyState title="No sales yet" description="Top products will appear once sales come in." />}
          />
        )}
      </CardContent>
    </Card>
  );
}
