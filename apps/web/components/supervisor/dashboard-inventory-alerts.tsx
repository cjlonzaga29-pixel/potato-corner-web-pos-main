import type { InventoryAlert } from '@potato-corner/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';

const MAX_VISIBLE_ALERTS = 10;
const SEVERITY_ORDER: Record<InventoryAlert['severity'], number> = { critical: 0, low: 1 };

interface DashboardInventoryAlertsProps {
  alerts: InventoryAlert[] | undefined;
  isLoading: boolean;
}

/** Panel 3 of the supervisor dashboard — low/critical stock alerts for the active branch. Pure display, no data fetching. */
export function DashboardInventoryAlerts({ alerts, isLoading }: DashboardInventoryAlertsProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!alerts || alerts.length === 0) {
    return <EmptyState title="All stock levels are healthy" />;
  }

  const sorted = [...alerts].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const visible = sorted.slice(0, MAX_VISIBLE_ALERTS);
  const remaining = sorted.length - visible.length;

  return (
    <div className="space-y-2">
      {visible.map((alert) => (
        <div key={alert.ingredient_id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span className="font-medium">{alert.name}</span>
          <span className="tabular-nums text-muted-foreground">
            {alert.current_stock} {alert.unit}
          </span>
          <StatusBadge status={alert.severity} type="inventory" />
        </div>
      ))}
      {remaining > 0 && <p className="text-xs text-muted-foreground">and {remaining} more</p>}
    </div>
  );
}
