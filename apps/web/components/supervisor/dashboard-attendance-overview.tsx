import Link from 'next/link';
import { ChevronRight, UserCheck } from 'lucide-react';
import type { AttendanceSummaryResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';

const MAX_VISIBLE_ROWS = 8;

function formatTimeOnly(date: string): string {
  return new Intl.DateTimeFormat('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' }).format(
    new Date(date),
  );
}

interface DashboardAttendanceOverviewProps {
  summary: AttendanceSummaryResponse | undefined;
  isLoading: boolean;
  isError?: boolean;
  /** Where "View attendance" goes — the existing branch attendance page. */
  href?: string;
}

/**
 * Panel 4 of the supervisor dashboard — POS-PERF-P47: built from the
 * attendance summary (GET /api/attendance/branch/:id/summary), i.e. actual
 * clock-in/clock-out records only. A login, an open POS session or a socket
 * connection never makes someone "clocked in" here. "Clocked in" uses the
 * same rule as the Staff Clocked In KPI (open record, employee active and
 * still assigned to this branch), so the two always agree. Pure display.
 */
export function DashboardAttendanceOverview({ summary, isLoading, isError = false, href }: DashboardAttendanceOverviewProps) {
  const header = (
    <CardHeader className="app-card-padding flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Attendance Overview</CardTitle>
      {href && (
        <Link href={href} className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          View attendance
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
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !summary) {
    return (
      <Card>
        {header}
        <CardContent className="app-card-padding pt-0">
          <p className="text-sm text-destructive">Couldn&apos;t load attendance. It will retry automatically.</p>
        </CardContent>
      </Card>
    );
  }

  const clockedIn = summary.clocked_in;
  const clockedOut = summary.clocked_out_today;
  // POS-PERF-P51 — on break is still clocked in (so "Clocked in now" keeps
  // matching the Staff Clocked In KPI); it is counted and labelled
  // separately. A pre-P51 API sends no attendance_state → never "on break".
  const onBreakCount = summary.on_break_count ?? clockedIn.filter((record) => record.attendance_state === 'on_break').length;

  return (
    <Card>
      {header}
      <CardContent className="app-card-padding space-y-3 pt-0">
        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-success/10 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Clocked in now</dt>
            <dd className="text-xl font-bold tabular-nums text-success">{clockedIn.length}</dd>
          </div>
          <div className="rounded-lg bg-warning/10 px-3 py-2">
            <dt className="text-xs text-muted-foreground">On break</dt>
            <dd className="text-xl font-bold tabular-nums text-warning">{onBreakCount}</dd>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Clocked out today</dt>
            <dd className="text-xl font-bold tabular-nums">{clockedOut.length}</dd>
          </div>
        </dl>

        {clockedIn.length === 0 && clockedOut.length === 0 ? (
          <EmptyState compact icon={UserCheck} title="No clock-ins recorded today" description="Staff appear here once they clock in at the branch." />
        ) : (
          <div className="space-y-3">
            {clockedIn.length > 0 && (
              <section aria-label="Clocked in now">
                <ul className="divide-y divide-border/60">
                  {clockedIn.slice(0, MAX_VISIBLE_ROWS).map((record) => (
                    <li key={record.record_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 truncate font-medium">{record.employee_name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="tabular-nums text-muted-foreground">In {formatTimeOnly(record.clock_in_server_time)}</span>
                        {record.attendance_state === 'on_break' ? (
                          <Badge variant="warning">
                            On break{record.break_started_at ? ` since ${formatTimeOnly(record.break_started_at)}` : ''}
                          </Badge>
                        ) : (
                          <StatusBadge status={record.clock_in_gps_status} type="gps" />
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {clockedIn.length > MAX_VISIBLE_ROWS && (
                  <p className="pt-1 text-xs text-muted-foreground">and {clockedIn.length - MAX_VISIBLE_ROWS} more clocked in</p>
                )}
              </section>
            )}
            {clockedOut.length > 0 && (
              <section aria-label="Clocked out today">
                <p className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Clocked out today</p>
                <ul className="divide-y divide-border/60">
                  {clockedOut.slice(0, MAX_VISIBLE_ROWS).map((record) => (
                    <li key={record.record_id} className="flex items-center justify-between gap-3 py-1.5 text-sm text-muted-foreground">
                      <span className="min-w-0 truncate">{record.employee_name}</span>
                      <span className="shrink-0 tabular-nums">
                        {formatTimeOnly(record.clock_in_server_time)} – {formatTimeOnly(record.clock_out_server_time)}
                      </span>
                    </li>
                  ))}
                </ul>
                {clockedOut.length > MAX_VISIBLE_ROWS && (
                  <p className="pt-1 text-xs text-muted-foreground">and {clockedOut.length - MAX_VISIBLE_ROWS} more clocked out</p>
                )}
              </section>
            )}
          </div>
        )}

        {summary.excluded_open_count > 0 && (
          <p className="text-xs text-muted-foreground">
            {summary.excluded_open_count} open clock-in{summary.excluded_open_count === 1 ? '' : 's'} belong to deactivated or reassigned
            staff and {summary.excluded_open_count === 1 ? 'is' : 'are'} not counted. Review them on the attendance page.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
