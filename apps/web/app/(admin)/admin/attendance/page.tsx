'use client';

import { useMemo, useState } from 'react';
import type { PaginationState } from '@tanstack/react-table';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { AttendanceStats } from '@/components/admin/attendance-stats';
import { createAttendanceColumns } from '@/components/admin/attendance-columns';
import { useAdminAttendance, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useBranches, useAllBranchStats } from '@/hooks/queries/use-branches';
import { useAllSupervisors, useEmployees } from '@/hooks/queries/use-employees';
import { manilaToday } from '@/lib/manila-date';

const ALL = 'all';
const DEFAULT_PAGINATION: PaginationState = { pageIndex: 0, pageSize: 25 };

type View = 'range' | 'open';

/**
 * POS-PERF-P40 — Admin attendance monitoring across every branch, read-only
 * (corrections stay in the Supervisor console). Filters:
 * - Branch, and/or Supervisor: a supervisor means "the branches that
 *   supervisor is currently assigned to" (the real assignment model); records
 *   are fetched once by branch, so overlapping assignments never duplicate a
 *   row.
 * - Employee (within the chosen branch) and Manila business dates.
 * - "Open now" lists every record still clocked in regardless of the day it
 *   started (overnight shifts included) and marks which ones the dashboard's
 *   "Staff Clocked In" figure counts, so the two reconcile record by record.
 */
export default function AdminAttendancePage() {
  useAttendanceRealtimeSync();

  const [view, setView] = useState<View>('range');
  const [branchId, setBranchId] = useState<string>(ALL);
  const [supervisorId, setSupervisorId] = useState<string>(ALL);
  const [employeeId, setEmployeeId] = useState<string>(ALL);
  const [from, setFrom] = useState(manilaToday());
  const [to, setTo] = useState(manilaToday());
  const [pagination, setPagination] = useState<PaginationState>(DEFAULT_PAGINATION);

  const branchFilter = branchId === ALL ? undefined : branchId;
  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const supervisors = useAllSupervisors();
  const { data: employeesData } = useEmployees({ branchId: branchFilter, role: 'staff', limit: 100 }, { enabled: Boolean(branchFilter) });
  const dashboardStats = useAllBranchStats(branchFilter);
  const { data, isLoading, isError, refetch } = useAdminAttendance({
    branch_id: branchFilter,
    supervisor_id: supervisorId === ALL ? undefined : supervisorId,
    employee_id: employeeId === ALL ? undefined : employeeId,
    open_only: view === 'open',
    from,
    to,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const branches = useMemo(() => branchesData?.branches ?? [], [branchesData]);
  const branchNames = useMemo(() => new Map(branches.map((branch) => [branch.id, branch.name])), [branches]);
  const employeeRoles = useMemo(() => new Map((employeesData?.employees ?? []).map((employee) => [employee.id, employee.role])), [employeesData]);
  const columns = useMemo(() => createAttendanceColumns({ employeeNames: new Map(), branchNames, employeeRoles }), [branchNames, employeeRoles]);
  const records = data?.records ?? [];

  const scopeText = useMemo(() => {
    const parts: string[] = [];
    if (data?.scope.supervisor) {
      const names = data.scope.supervisor.branch_ids.map((id) => branchNames.get(id) ?? 'Unknown branch');
      parts.push(`${data.scope.supervisor.name}'s current branches (${names.length > 0 ? names.join(', ') : 'none assigned'})`);
      if (branchFilter) parts.push(`limited to ${branchNames.get(branchFilter) ?? 'the selected branch'}`);
    } else {
      parts.push(branchFilter ? (branchNames.get(branchFilter) ?? 'Selected branch') : 'All branches');
    }
    parts.push(view === 'open' ? 'everyone still clocked in, any start date' : `${from} to ${to} (by clock-in, Manila time)`);
    return parts.join(' · ');
  }, [data, branchNames, branchFilter, view, from, to]);

  const dashboardClockedIn = dashboardStats.data?.reduce((sum, row) => sum + row.staffTimedInCount, 0);
  const countedOpen = records.filter((record) => record.counts_toward_clocked_in === true).length;
  const notCountedOpen = records.filter((record) => record.counts_toward_clocked_in === false).length;

  function resetPage() {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="app-title font-bold">Attendance Monitoring</h1>
        <p className="text-sm text-muted-foreground">Clock-in/out records across branches. Read-only — corrections are made from the Supervisor console.</p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Attendance view">
        <Button variant={view === 'range' ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === 'range'} onClick={() => { setView('range'); resetPage(); }}>
          By date
        </Button>
        <Button variant={view === 'open' ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === 'open'} onClick={() => { setView('open'); resetPage(); }}>
          Clocked in now
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-auto">
          <Label htmlFor="attendance-branch-filter">Branch</Label>
          <Select
            value={branchId}
            onValueChange={(value) => {
              setBranchId(value);
              setEmployeeId(ALL);
              resetPage();
            }}
          >
            <SelectTrigger id="attendance-branch-filter" className="w-full sm:w-[220px]" disabled={isBranchesLoading}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-full sm:w-auto">
          <Label htmlFor="attendance-supervisor-filter">Supervisor</Label>
          <Select
            value={supervisorId}
            onValueChange={(value) => {
              setSupervisorId(value);
              resetPage();
            }}
          >
            <SelectTrigger id="attendance-supervisor-filter" className="w-full sm:w-[220px]" disabled={supervisors.isLoading}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any supervisor</SelectItem>
              {(supervisors.data ?? []).map((supervisor) => (
                <SelectItem key={supervisor.id} value={supervisor.id}>
                  {supervisor.first_name} {supervisor.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-full sm:w-auto">
          <Label htmlFor="attendance-employee-filter">Employee</Label>
          <Select
            value={employeeId}
            disabled={!branchFilter}
            onValueChange={(value) => {
              setEmployeeId(value);
              resetPage();
            }}
          >
            <SelectTrigger id="attendance-employee-filter" className="w-full sm:w-[220px]" aria-describedby="attendance-employee-hint">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All employees</SelectItem>
              {(employeesData?.employees ?? []).map((employee) => (
                <SelectItem key={employee.id} value={employee.id}>
                  {employee.first_name} {employee.last_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!branchFilter && (
            <p id="attendance-employee-hint" className="mt-1 text-xs text-muted-foreground">
              Choose a branch to pick an employee.
            </p>
          )}
        </div>

        {view === 'range' && (
          <>
            <div>
              <Label htmlFor="attendance-from">From</Label>
              <Input
                id="attendance-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => {
                  setFrom(e.target.value);
                  resetPage();
                }}
              />
            </div>
            <div>
              <Label htmlFor="attendance-to">To</Label>
              <Input
                id="attendance-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => {
                  setTo(e.target.value);
                  resetPage();
                }}
              />
            </div>
          </>
        )}
      </div>

      <p className="text-sm" aria-live="polite">
        <span className="font-medium">Showing:</span> {scopeText}
        {data ? ` · ${data.total} record${data.total === 1 ? '' : 's'}` : ''}
      </p>

      {view === 'open' && data && !data.scope.supervisor && employeeId === ALL && (
        <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          Dashboard &quot;Staff Clocked In&quot; for this scope: <span className="font-semibold text-foreground">{dashboardClockedIn ?? '—'}</span>. Of the open
          records on this page, {countedOpen} count toward it and {notCountedOpen} do not (the employee is inactive or no longer assigned to that
          branch). Records are never changed to make these match.
        </p>
      )}

      <AttendanceStats records={records} isLoading={isLoading} />

      <DataTable
        columns={columns}
        data={records}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        emptyState={
          <EmptyState
            title="No attendance records"
            description={view === 'open' ? 'Nobody in this scope is clocked in right now.' : 'No attendance records found for this scope and period.'}
          />
        }
      />
    </div>
  );
}
