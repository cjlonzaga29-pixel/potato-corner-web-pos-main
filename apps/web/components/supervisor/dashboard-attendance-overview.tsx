import type { AttendanceResponse } from '@potato-corner/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { truncateText } from '@/lib/utils';

function formatTimeOnly(date: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
}

interface DashboardAttendanceOverviewProps {
  records: AttendanceResponse[] | undefined;
  isLoading: boolean;
}

/** Panel 4 of the supervisor dashboard — today's clock-in/out overview for the active branch. Pure display, no data fetching. */
export function DashboardAttendanceOverview({ records, isLoading }: DashboardAttendanceOverviewProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  const list = records ?? [];
  const clockedIn = list.filter((r) => !r.clock_out_server_time);
  const clockedOut = list.filter((r) => Boolean(r.clock_out_server_time));

  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-sm">
        <span>{clockedIn.length} clocked in</span>
        <span className="text-muted-foreground">{clockedOut.length} clocked out</span>
        <span className="text-muted-foreground">{list.length} total today</span>
      </div>

      {clockedIn.length === 0 ? (
        <EmptyState title="No staff currently clocked in" />
      ) : (
        <div className="space-y-2">
          {clockedIn.map((record) => (
            <div key={record.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">{truncateText(record.employee_id, 13)}</span>
              <span className="tabular-nums text-muted-foreground">{formatTimeOnly(record.clock_in_server_time)}</span>
              <StatusBadge status={record.clock_in_gps_status} type="gps" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
