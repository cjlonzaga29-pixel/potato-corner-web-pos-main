'use client';

import { useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { KeyRound, Pencil, Plus, Trash2, UserCog } from 'lucide-react';
import { ROLES, type EmployeeResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useStaffPinStatus } from '@/hooks/queries/use-staff-pin';
import { refocusRowAction } from '@/lib/refocus-row-action';
import { useBranchStore } from '@/stores/branch.store';
import { SupervisorCreateEmployeeDialog } from '@/components/supervisor/employees/create-employee-dialog';
import { SupervisorEditEmployeeDialog } from '@/components/supervisor/employees/edit-employee-dialog';
import { SetEmployeeStatusDialog } from '@/components/supervisor/employees/set-employee-status-dialog';
import { ManageStaffPinDialog } from '@/components/supervisor/employees/manage-staff-pin-dialog';
import { RemoveEmployeeDialog } from '@/components/supervisor/employees/remove-employee-dialog';

/**
 * POS-PERF-P47 — PIN state for a staff row, never the PIN itself: "PIN set"
 * (an active PIN exists), "PIN off" (a PIN was set then deactivated) or
 * "No PIN" (never set). Shared by the status cell and the action button so
 * the label and the button ("Set PIN" / "Reset PIN") always agree.
 */
function usePinState(employee: EmployeeResponse) {
  const isStaff = employee.role === ROLES.STAFF;
  const status = useStaffPinStatus(employee.id, isStaff);
  const state: 'loading' | 'error' | 'set' | 'off' | 'none' = status.isLoading
    ? 'loading'
    : status.isError
      ? 'error'
      : status.data?.has_pin && status.data.is_active
        ? 'set'
        : status.data?.has_pin
          ? 'off'
          : 'none';
  return { isStaff, state };
}

function PinStatusCell({ employee }: { employee: EmployeeResponse }) {
  const { isStaff, state } = usePinState(employee);
  if (!isStaff) return <span className="text-muted-foreground">—</span>;
  if (state === 'loading') return <span className="text-xs text-muted-foreground">Checking…</span>;
  if (state === 'error') return <span className="text-xs text-destructive">Unavailable</span>;
  if (state === 'set') return <Badge variant="active">PIN set</Badge>;
  if (state === 'off') return <Badge variant="secondary">PIN off</Badge>;
  return <Badge variant="warning">No PIN</Badge>;
}

function PinActionButton({ employee, onClick }: { employee: EmployeeResponse; onClick: () => void }) {
  const { state } = usePinState(employee);
  const label = state === 'set' ? 'Reset PIN' : 'Set PIN';
  return (
    <Button
      type="button"
      size="sm"
      variant={state === 'set' ? 'outline' : 'default'}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${label} for ${employee.first_name} ${employee.last_name}`}
      data-row-action={`pin:${employee.id}`}
    >
      <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * Shared body behind both `/supervisor/employees` and `/branch/employees` —
 * the backend already scopes GET /api/employees to the caller's accessible
 * branches and excludes super_admin rows for any non-admin role (see
 * employees.service.ts's getAllEmployees).
 *
 * POS-PERF-P47 — the list is additionally narrowed to the sidebar's active
 * branch (branch_id, re-checked server-side against the caller's access), so a
 * supervisor assigned to several branches sees the selected branch's people
 * only, and switching branches switches the list with it.
 */
export function EmployeesList({ basePath }: { basePath: string }) {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<EmployeeResponse | null>(null);
  const [statusEmployee, setStatusEmployee] = useState<EmployeeResponse | null>(null);
  const [pinEmployee, setPinEmployee] = useState<EmployeeResponse | null>(null);
  const [removeEmployee, setRemoveEmployee] = useState<EmployeeResponse | null>(null);

  const { data, isLoading, isError, refetch } = useEmployees(
    { branchId: activeBranchId ?? undefined, search: search || undefined, limit: 100 },
    { enabled: Boolean(activeBranchId) },
  );
  // useEmployees keeps the previous page while refetching; drop any row that
  // isn't assigned to the now-active branch so a branch switch never shows
  // the previous branch's people, even for a moment.
  const employees = (data?.employees ?? []).filter((employee) =>
    employee.branch_assignments.some((assignment) => assignment.branch_id === activeBranchId),
  );

  const columns: ColumnDef<EmployeeResponse>[] = [
    // POS-PERF-P47 — PIN state and the row actions sit right after the name
    // so Set PIN / Edit / Delete are on screen without scrolling on phones.
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => `${row.original.first_name} ${row.original.last_name}`,
    },
    {
      id: 'pin_status',
      header: 'POS / Inventory PIN',
      cell: ({ row }) => <PinStatusCell employee={row.original} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const employee = row.original;
        const fullName = `${employee.first_name} ${employee.last_name}`;
        // POS-PERF-P47 — supervisors manage staff only; supervisor and branch
        // accounts that share the branch are changed by a Super Admin (the
        // server refuses it either way — this just doesn't offer it).
        if (employee.role !== ROLES.STAFF) {
          return <span className="whitespace-nowrap text-xs text-muted-foreground">Managed by Super Admin</span>;
        }
        const stop = (action: () => void) => (event: MouseEvent) => {
          event.stopPropagation();
          action();
        };
        return (
          <div className="flex max-w-[11rem] flex-wrap items-center gap-1 sm:max-w-none sm:flex-nowrap">
            <PinActionButton employee={employee} onClick={() => setPinEmployee(employee)} />
            <Button type="button" variant="ghost" size="sm" onClick={stop(() => setEditingEmployee(employee))} aria-label={`Edit ${fullName}`} data-row-action={`edit:${employee.id}`}>
              <Pencil className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="hidden sm:inline">Edit</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={stop(() => setStatusEmployee(employee))}
              aria-label={`Change status for ${fullName}`}
              data-row-action={`status:${employee.id}`}
            >
              <UserCog className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="hidden sm:inline">Status</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={stop(() => setRemoveEmployee(employee))}
              aria-label={`Delete or deactivate ${fullName}`}
              data-row-action={`remove:${employee.id}`}
            >
              <Trash2 className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: 'position',
      header: 'Position',
      cell: ({ row }) => row.original.position ?? '—',
    },
    {
      accessorKey: 'employment_type',
      header: 'Employment Type',
      cell: ({ row }) => <span className="capitalize">{row.original.employment_type.replace('_', ' ')}</span>,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} type="employee" />,
    },
    {
      id: 'last_login',
      header: 'Last Login',
      cell: ({ row }) => (row.original.last_login_at ? formatDateTime(row.original.last_login_at) : 'Never'),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Branch Staff</h1>
          <p className="text-sm text-muted-foreground">
            Employees assigned to your branch. Use <span className="font-medium">Set PIN</span> for anyone marked{' '}
            <span className="font-medium">No PIN</span> — they need it to sign in at the POS and clock in.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Create Employee
        </Button>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Search by name..." className="max-w-xs" />

      <DataTable
        columns={columns}
        data={employees}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        onRowClick={(employee) => router.push(`${basePath}/employees/${employee.id}`)}
        emptyState={<EmptyState title="No employees" description="No employees are assigned to your branch yet." />}
      />

      <SupervisorCreateEmployeeDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editingEmployee && (
        <SupervisorEditEmployeeDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            refocusRowAction(`edit:${editingEmployee.id}`);
            setEditingEmployee(null);
          }}
          employee={editingEmployee}
        />
      )}
      {statusEmployee && (
        <SetEmployeeStatusDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            refocusRowAction(`status:${statusEmployee.id}`);
            setStatusEmployee(null);
          }}
          employee={statusEmployee}
        />
      )}
      {pinEmployee && (
        <ManageStaffPinDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            refocusRowAction(`pin:${pinEmployee.id}`);
            setPinEmployee(null);
          }}
          employee={pinEmployee}
        />
      )}
      {removeEmployee && (
        <RemoveEmployeeDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            // Deleted rows are gone; the button is simply not found then.
            refocusRowAction(`remove:${removeEmployee.id}`);
            setRemoveEmployee(null);
          }}
          employee={removeEmployee}
        />
      )}
    </div>
  );
}
