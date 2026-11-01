import Link from 'next/link';
import { ChevronRight, PackageCheck } from 'lucide-react';
import type { InventoryStockAlert } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { stockBadgeStatus, stockStateOf, type StockState } from '@/lib/inventory-stock-status';

const MAX_VISIBLE_ALERTS = 10;
const STATE_ORDER: Record<StockState, number> = { out: 0, critical: 1, low: 2, healthy: 3 };
const stateOf = (alert: InventoryStockAlert) => stockStateOf({ quantity_available: alert.quantity_available, status: alert.severity });

interface DashboardInventoryAlertsProps {
  alerts: InventoryStockAlert[] | undefined;
  isLoading: boolean;
  /** POS-PERF-P47 — the filtered inventory list behind these alerts (same branch, same rule). */
  href?: string;
  /** POS-PERF-P48 — per-alert link into the transfer page with this branch as destination; omitted when there is no other branch to send from. */
  prepareTransferHref?: (alert: InventoryStockAlert) => string;
}

/** Panel 3 of the supervisor dashboard — out-of-stock, critical and low inventory items at the active branch, sourced from InventoryStock (branch inventory cutover). Items, not products: see DashboardProductAvailability. Pure display, no data fetching. */
export function DashboardInventoryAlerts({ alerts, isLoading, href, prepareTransferHref }: DashboardInventoryAlertsProps) {
  const header = (
    <CardHeader className="app-card-padding flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Inventory item alerts</CardTitle>
      {href && (alerts?.length ?? 0) > 0 && (
        <Link
          href={href}
          className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View all {alerts?.length}
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      )}
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card>
        {header}
        <CardContent className="app-card-padding space-y-2 pt-0">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const sorted = [...(alerts ?? [])].sort((a, b) => STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)]);
  const visible = sorted.slice(0, MAX_VISIBLE_ALERTS);
  const remaining = sorted.length - visible.length;

  return (
    <Card>
      {header}
      <CardContent className="app-card-padding pt-0">
        {sorted.length === 0 ? (
          <EmptyState compact icon={PackageCheck} title="All tracked items have stock" description="No tracked item is out of stock or at its low or critical threshold." />
        ) : (
          <div className="divide-y divide-border/60">
            {visible.map((alert) => (
              <div
                key={alert.inventory_item_id}
                className="-mx-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-muted/40"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{alert.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground" title={`${alert.quantity_on_hand} on hand, ${alert.quantity_reserved} reserved`}>
                  {alert.quantity_available} avail.
                </span>
                <StatusBadge status={stockBadgeStatus(stateOf(alert))} type="inventory" />
                {prepareTransferHref && (
                  <Link
                    href={prepareTransferHref(alert)}
                    aria-label={`Prepare transfer for ${alert.name}`}
                    className="shrink-0 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Prepare transfer
                  </Link>
                )}
              </div>
            ))}
            {remaining > 0 && <p className="pt-2 text-xs text-muted-foreground">and {remaining} more</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
