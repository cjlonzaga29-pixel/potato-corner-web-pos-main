'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import type { AttendanceResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime, formatDuration } from '@/lib/utils';
import { manilaDateString, manilaToday } from '@/lib/manila-date';

const CORRECTION_REASON_TRUNCATE_LENGTH = 40;

function truncateId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** See attendance-view.tsx's identical helper — kept in sync so admin and supervisor never disagree on what counts as stale. */
function isStaleOpenShift(record: AttendanceResponse): boolean {
  return record.clock_out_server_time === null && manilaDateString(new Date(record.clock_in_server_time)) !== manilaToday();
}

export interface AttendanceColumnOptions {
  employeeNames: Map<string, string>;
  branchNames: Map<string, string>;
}

/** Read-only column set for the admin monitoring table — no actions column, unlike the supervisor page's equivalent. */
export function createAttendanceColumns({ employeeNames, branchNames }: AttendanceColumnOptions): ColumnDef<AttendanceResponse>[] {
  return [
    {
      id: 'employee_id',
      header: 'Employee',
      cell: ({ row }) => {
        // Primary source is the API's own employee relation; the roster map
        // and truncated id are fallbacks only — never the raw UUID as-is.
        const name = row.original.employee_name ?? employeeNames.get(row.original.employee_id) ?? 'Former Employee';
        return (
          <div>
            <div>{name}</div>
            {row.original.employee_code && <div className="text-xs text-muted-foreground">{row.original.employee_code}</div>}
          </div>
        );
      },
    },
    {
      id: 'branch_id',
      header: 'Branch',
      cell: ({ row }) => branchNames.get(row.original.branch_id) ?? truncateId(row.original.branch_id),
    },
    {
      id: 'clock_in_server_time',
      header: 'Clock In',
      cell: ({ row }) => formatDateTime(row.original.clock_in_server_time),
    },
    {
      id: 'clock_out_server_time',
      header: 'Clock Out',
      cell: ({ row }) => {
        if (row.original.clock_out_server_time) return formatDateTime(row.original.clock_out_server_time);
        if (isStaleOpenShift(row.original)) {
          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Stale open shift
                  </span>
                </TooltipTrigger>
                <TooltipContent>Clocked in on a prior day and never clocked out — likely a missed clock-out, not an active shift.</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        }
        return <Badge variant="pending">Still clocked in</Badge>;
      },
    },
    {
      id: 'break_minutes',
      header: 'Break',
      cell: ({ row }) => formatDuration(row.original.break_minutes),
    },
    {
      id: 'actual_work_minutes',
      header: 'Worked',
      cell: ({ row }) => (row.original.actual_work_minutes === null ? '—' : formatDuration(row.original.actual_work_minutes)),
    },
    {
      id: 'overtime_minutes',
      header: 'Overtime',
      cell: ({ row }) => formatDuration(row.original.overtime_minutes),
    },
    {
      id: 'clock_in_gps_status',
      header: 'GPS',
      cell: ({ row }) => <StatusBadge status={row.original.clock_in_gps_status} type="gps" />,
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) =>
        isStaleOpenShift(row.original) ? <Badge variant="warning">Needs Review</Badge> : <StatusBadge status={row.original.status} type="attendance" />,
    },
    {
      id: 'correction_reason',
      header: 'Correction Reason',
      cell: ({ row }) => {
        const reason = row.original.correction_reason;
        if (!reason) return '—';
        if (reason.length <= CORRECTION_REASON_TRUNCATE_LENGTH) return reason;
        const truncated = `${reason.slice(0, CORRECTION_REASON_TRUNCATE_LENGTH)}…`;
        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">{truncated}</span>
              </TooltipTrigger>
              <TooltipContent>{reason}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      },
    },
  ];
}
