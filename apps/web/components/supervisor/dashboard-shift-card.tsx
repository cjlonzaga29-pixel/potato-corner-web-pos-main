import type { ShiftResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency, formatTimeAgo, truncateText } from '@/lib/utils';

function formatTimeOnly(date: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(date));
}

interface DashboardShiftCardProps {
  shift: ShiftResponse | null | undefined;
  isLoading: boolean;
}

/** Panel 1 of the supervisor dashboard — the branch's currently active cash shift, if any. Pure display, no data fetching. */
export function DashboardShiftCard({ shift, isLoading }: DashboardShiftCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-28" />
        </CardContent>
      </Card>
    );
  }

  if (!shift) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            title="No active shift"
            description="Open a shift from the POS terminal to begin tracking sales"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <span className="text-sm font-medium text-muted-foreground">Active Shift</span>
        <StatusBadge status={shift.status} type="shift" />
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>
          <span className="text-muted-foreground">Opened by:</span> {truncateText(shift.cashier_id, 13)}
        </p>
        <p>
          <span className="text-muted-foreground">Since:</span> {formatTimeAgo(shift.started_at)} ({formatTimeOnly(shift.started_at)})
        </p>
        <p className="pt-1 text-2xl font-bold">{formatCurrency(shift.opening_cash_amount)}</p>
        <p className="text-xs text-muted-foreground">Opening cash</p>
      </CardContent>
    </Card>
  );
}
