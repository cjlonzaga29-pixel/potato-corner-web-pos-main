'use client';

import { useState } from 'react';
import type { PaginationState } from '@tanstack/react-table';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AttendanceStats } from '@/components/admin/attendance-stats';
import { createAttendanceColumns } from '@/components/admin/attendance-columns';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useBranches } from '@/hooks/queries/use-branches';
import { useEmployees } from '@/hooks/queries/use-employees';

const ALL_EMPLOYEES = 'all';
const DEFAULT_PAGINATION: PaginationState = { pageIndex: 0, pageSize: 25 };

function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function startOfDayISO(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}

function endOfDayISO(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

/**
 * super_admin monitoring view across every branch, one branch at a time via
 * the selector below — reuses GET /api/attendance/branch/:branchId exactly
 * as the supervisor page does (same hook, same query key). Read-only: no
 * override capability here, that stays on the supervisor console's
 * AttendanceOverrideDialog.
 */
export default function AdminAttendancePage() {
  useAttendanceRealtimeSync();

  const [branchId, setBranchId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string>(ALL_EMPLOYEES);
  const [from, setFrom] = useState(todayDateString());
  const [to, setTo] = useState(todayDateString());
  const [pagination, setPagination] = useState<PaginationState>(DEFAULT_PAGINATION);

  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const { data: employeesData } = useEmployees({ branchId: branchId ?? undefined, limit: 100 });
  const { data, isLoading, isError, refetch } = useAttendanceByBranch(branchId, {
    employee_id: employeeId === ALL_EMPLOYEES ? undefined : employeeId,
    from: startOfDayISO(from),
    to: endOfDayISO(to),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const branches = branchesData?.branches ?? [];
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const employeeNames = new Map((employeesData?.employees ?? []).map((employee) => [employee.id, `${employee.first_name} ${employee.last_name}`]));
  const records = data?.records ?? [];
  const columns = createAttendanceColumns({ employeeNames, branchNames });

  function resetToFirstPage() {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }

  function handleBranchChange(value: string) {
    setBranchId(value);
    setEmployeeId(ALL_EMPLOYEES);
    setFrom(todayDateString());
    setTo(todayDateString());
    setPagination(DEFAULT_PAGINATION);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Attendance Monitoring</h1>
        <p className="text-sm text-muted-foreground">Clock-in/out records for any branch. Read-only — corrections are made from the supervisor console.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="attendance-branch-filter">Branch</Label>
          <Select value={branchId ?? undefined} onValueChange={handleBranchChange}>
            <SelectTrigger id="attendance-branch-filter" className="w-[240px]" disabled={isBranchesLoading}>
              <SelectValue placeholder="Select a branch" />
            </SelectTrigger>
            <SelectContent>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {branchId && (
          <>
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
          </>
        )}
      </div>

      {!branchId ? (
        <EmptyState title="Select a branch" description="Choose a branch above to view its attendance records." />
      ) : (
        <>
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
            emptyState={<EmptyState title="No attendance records" description="No attendance records found for this period." />}
          />
        </>
      )}
    </div>
  );
}
