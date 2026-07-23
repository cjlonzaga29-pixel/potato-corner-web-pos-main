'use client';

import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { formatCurrency } from '@/lib/utils';
import { useBranchInventoryAlerts } from '@/hooks/queries/use-inventory';
import { useAdminInventoryRollup } from '@/hooks/queries/use-admin-inventory-rollup';

const SKELETON_ROWS = 4;

interface DashboardInventoryAlertsProps {
  branchFilter: string | undefined;
}

interface AlertRow {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  severity: 'low' | 'critical';
}

/**
 * Super admin dashboard section — low/critical stock items, plus (when
 * viewing all branches) the valuation rollup totals. Scoped to the selected
 * branch via the branch alerts endpoint (has real thresholds); when no
 * branch is selected, derives the same low/critical set — and the total
 * value / low / critical counts — from the all-branch valuation rollup,
 * since there is no dedicated cross-branch alerts endpoint.
 */
export function DashboardInventoryAlerts({ branchFilter }: DashboardInventoryAlertsProps) {
  const branchAlerts = useBranchInventoryAlerts(branchFilter);
  const rollup = useAdminInventoryRollup();

  const isLoading = branchFilter ? branchAlerts.isLoading : rollup.isLoading;
  const isError = branchFilter ? branchAlerts.isError : rollup.isError;

  const rows: AlertRow[] = branchFilter
    ? (branchAlerts.data?.alerts ?? []).map((alert) => ({
        id: alert.ingredient_id,
        name: alert.name,
        unit: alert.unit,
        currentStock: alert.current_stock,
        severity: alert.severity,
      }))
    : (rollup.data?.data ?? [])
        .filter((row) => row.status !== 'ok')
        .map((row) => ({
          id: row.ingredient_id,
          name: row.ingredient_name,
          unit: row.unit,
          currentStock: row.current_stock,
          severity: row.status as 'low' | 'critical',
        }));

  const sortedRows = [...rows].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Rollup totals only apply to the all-branches valuation snapshot — there's no per-branch total-value endpoint.
  const rollupData = rollup.data?.data ?? [];
  const totalValue = rollupData.reduce((sum, row) => sum + row.total_value, 0);
  const lowStockCount = rollupData.filter((row) => row.status === 'low').length;
  const criticalStockCount = rollupData.filter((row) => row.status === 'critical').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Inventory Alerts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title="Failed to load inventory alerts"
            retry={() => (branchFilter ? void branchAlerts.refetch() : void rollup.refetch())}
          />
        ) : (
          <>
            {!branchFilter && (
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
            )}
            {sortedRows.length === 0 ? (
              <EmptyState title="No low stock alerts" description="Every tracked ingredient is above its reorder threshold." />
            ) : (
              <div className="space-y-2">
                {sortedRows.map((row) => (
                  <div key={row.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <AlertTriangle
                        className={`h-3 w-3 shrink-0 ${row.severity === 'critical' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`}
                      />
                      <span className="truncate">{row.name}</span>
                    </div>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {row.currentStock} {row.unit}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
