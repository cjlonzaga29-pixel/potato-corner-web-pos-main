'use client';

import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency } from '@/lib/utils';
import { useAdminInventoryRollup } from '@/hooks/queries/use-admin-inventory-rollup';

const TOP_AT_RISK_LIMIT = 5;
const SKELETON_ROWS = 4;

/** Super admin dashboard card — aggregates the inventory valuation snapshot across all branches. Self-fetching. */
export function InventoryRollupCard() {
  const { data, isLoading, isError, refetch } = useAdminInventoryRollup();

  const rows = data?.data ?? [];
  const totalValue = rows.reduce((sum, row) => sum + row.total_value, 0);
  const lowStockCount = rows.filter((row) => row.status === 'low').length;
  const criticalStockCount = rows.filter((row) => row.status === 'critical').length;
  const topAtRisk = rows
    .filter((row) => row.status !== 'ok')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'critical' ? -1 : 1;
      return b.total_value - a.total_value;
    })
    .slice(0, TOP_AT_RISK_LIMIT);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Inventory Rollup</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState title="Failed to load inventory rollup" retry={() => refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No inventory data available" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Total Value</p>
                <p className="font-medium">{formatCurrency(totalValue)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Low Stock</p>
                <p className="font-medium">{lowStockCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Critical Stock</p>
                <p className="font-medium">{criticalStockCount}</p>
              </div>
            </div>
            {topAtRisk.length > 0 && (
              <div className="space-y-2">
                {topAtRisk.map((row) => (
                  <div
                    key={row.ingredient_id}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <AlertTriangle
                        className={`h-3 w-3 shrink-0 ${row.status === 'critical' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`}
                      />
                      <span className="truncate">{row.ingredient_name}</span>
                    </div>
                    <span className="shrink-0 tabular-nums font-medium">{formatCurrency(row.total_value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
