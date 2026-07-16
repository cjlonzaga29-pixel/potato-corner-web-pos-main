'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { AttendanceResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime, formatDuration } from '@/lib/utils';

const CORRECTION_REASON_TRUNCATE_LENGTH = 40;

function truncateId(id: string): string {
  return `${id.slice(0, 8)}…`;
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
      cell: ({ row }) => employeeNames.get(row.original.employee_id) ?? truncateId(row.original.employee_id),
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
      cell: ({ row }) =>
        row.original.clock_out_server_time ? (
          formatDateTime(row.original.clock_out_server_time)
        ) : (
          <Badge variant="pending">Still clocked in</Badge>
        ),
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
      cell: ({ row }) => <StatusBadge status={row.original.status} type="attendance" />,
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
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default">{truncated}</span>
            </TooltipTrigger>
            <TooltipContent>{reason}</TooltipContent>
          </Tooltip>
        );
      },
    },
  ];
}
