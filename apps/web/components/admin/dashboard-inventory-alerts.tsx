'use client';

import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { formatCurrency } from '@/lib/utils';
import { useBranchInventoryStockAlerts } from '@/hooks/queries/use-universal-inventory';
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
 * branch via the branch inventory-stock alerts endpoint (branch inventory
 * cutover — InventoryStock/InventoryItem, has real thresholds); when no
 * branch is selected, shows the InventoryStock/InventoryItem-sourced
 * all-branch valuation rollup instead — a per-branch breakdown, not a flat
 * item list, since the rollup has no item-level data (that would require
 * a cross-branch item alert endpoint that doesn't exist on the new model).
 */
export function DashboardInventoryAlerts({ branchFilter }: DashboardInventoryAlertsProps) {
  const branchAlerts = useBranchInventoryStockAlerts(branchFilter);
  const rollup = useAdminInventoryRollup();

  const isLoading = branchFilter ? branchAlerts.isLoading : rollup.isLoading;
  const isError = branchFilter ? branchAlerts.isError : rollup.isError;

  const rows: AlertRow[] = branchFilter
    ? (branchAlerts.data?.alerts ?? []).map((alert) => ({
        id: alert.inventory_item_id,
        name: alert.name,
        unit: '',
        currentStock: alert.quantity_on_hand,
        severity: alert.severity,
      }))
    : [];

  const sortedRows = [...rows].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const branchRows = rollup.data?.branches ?? [];
  const summary = rollup.data?.summary;

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
        ) : branchFilter ? (
          sortedRows.length === 0 ? (
            <EmptyState title="No low stock alerts" description="Every tracked item is above its reorder threshold." />
          ) : (
            <div className="space-y-2">
              {sortedRows.map((row) => (
                <div key={row.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <AlertTriangle
                      className={`h-3 w-3 shrink-0 ${row.severity === 'critical' ? 'text-destructive' : 'text-warning'}`}
                    />
                    <span className="truncate">{row.name}</span>
                  </div>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {row.currentStock}
                    {row.unit ? ` ${row.unit}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Total Value</p>
                <p className="font-medium">{formatCurrency(summary?.total_inventory_value ?? 0)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Low Stock</p>
                <p className="font-medium">{summary?.total_low_stock_rows ?? 0}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Critical Stock</p>
                <p className="font-medium">{summary?.total_critical_stock_rows ?? 0}</p>
              </div>
            </div>
            {branchRows.length === 0 ? (
              <EmptyState title="No inventory recorded" description="No branch has any stocked inventory items yet." />
            ) : (
              <div className="space-y-2">
                {branchRows.map((row) => (
                  <div key={row.branch_id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {(row.critical_stock_count > 0 || row.out_of_stock_count > 0) && (
                        <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                      )}
                      {row.critical_stock_count === 0 && row.out_of_stock_count === 0 && row.low_stock_count > 0 && (
                        <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
                      )}
                      <span className="truncate">{row.branch_name}</span>
                    </div>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatCurrency(row.total_inventory_value)}</span>
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
