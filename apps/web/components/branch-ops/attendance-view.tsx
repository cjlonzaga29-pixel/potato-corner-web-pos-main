'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { AttendanceResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { AttendanceOverrideDialog } from '@/components/supervisor/attendance-override-dialog';
import { formatDateTime, formatDuration } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useEmployees } from '@/hooks/queries/use-employees';

const ALL_EMPLOYEES = 'all';

/**
 * Shared body behind both `/supervisor/attendance` and `/branch/attendance`.
 * GET /api/attendance/branch/:branchId requires branchGuard — the active
 * branch comes from useBranchStore either way (a supervisor's
 * BranchSelector, or the branch role's JWT-seeded value — see
 * BranchContextSync).
 */
export function AttendanceView() {
  useAttendanceRealtimeSync();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [employeeId, setEmployeeId] = useState<string>(ALL_EMPLOYEES);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [correctingRecord, setCorrectingRecord] = useState<AttendanceResponse | null>(null);

  const { data: employeesData } = useEmployees({ branchId: activeBranchId ?? undefined, limit: 100 });
  const employeeNames = new Map((employeesData?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`]));

  const { data, isLoading, isError, refetch } = useAttendanceByBranch(activeBranchId, {
    employee_id: employeeId === ALL_EMPLOYEES ? undefined : employeeId,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  function resetToFirstPage() {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  const columns: ColumnDef<AttendanceResponse>[] = [
    { id: 'employee', header: 'Employee', cell: ({ row }) => employeeNames.get(row.original.employee_id) ?? row.original.employee_id },
    { id: 'clock_in', header: 'Clock In', cell: ({ row }) => formatDateTime(row.original.clock_in_server_time) },
    {
      id: 'clock_out',
      header: 'Clock Out',
      cell: ({ row }) => (row.original.clock_out_server_time ? formatDateTime(row.original.clock_out_server_time) : 'Still clocked in'),
    },
    {
      id: 'duration',
      header: 'Duration',
      cell: ({ row }) => (row.original.actual_work_minutes === null ? '—' : formatDuration(row.original.actual_work_minutes)),
    },
    { id: 'gps', header: 'GPS', cell: ({ row }) => <StatusBadge status={row.original.clock_in_gps_status} type="gps" /> },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="attendance" /> },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button variant="outline" size="sm" onClick={() => setCorrectingRecord(row.original)}>
          Correct
        </Button>
      ),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its attendance records.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Attendance</h1>
        <p className="text-sm text-muted-foreground">Clock-in/out records for your active branch.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="attendance-employee-filter">Employee</Label>
          <Select
            value={employeeId}
            onValueChange={(value) => {
              setEmployeeId(value);
              resetToFirstPage();
            }}
          >
            <SelectTrigger id="attendance-employee-filter" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_EMPLOYEES}>All employees</SelectItem>
              {(employeesData?.employees ?? []).map((employee) => (
                <SelectItem key={employee.id} value={employee.id}>
                  {employee.first_name} {employee.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="attendance-from">From</Label>
          <Input
            id="attendance-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetToFirstPage();
            }}
          />
        </div>
        <div>
          <Label htmlFor="attendance-to">To</Label>
          <Input
            id="attendance-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetToFirstPage();
            }}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={data?.records ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        emptyState={<EmptyState title="No attendance records" description="No clock-in/out records match this filter." />}
      />

      {correctingRecord && (
        <AttendanceOverrideDialog
          open={Boolean(correctingRecord)}
          onOpenChange={(open) => {
            if (!open) setCorrectingRecord(null);
          }}
          record={correctingRecord}
        />
      )}
    </div>
  );
}
