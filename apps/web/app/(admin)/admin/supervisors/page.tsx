'use client';

import { useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Pencil, Plus, Trash2, UserCog } from 'lucide-react';
import type { EmployeeResponse, EmploymentType } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { refocusRowAction } from '@/lib/refocus-row-action';
import { useEmployees } from '@/hooks/queries/use-employees';
import { AddSupervisorDialog } from '@/components/admin/employees/add-supervisor-dialog';
import { SupervisorEditEmployeeDialog } from '@/components/supervisor/employees/edit-employee-dialog';
import { SetEmployeeStatusDialog } from '@/components/supervisor/employees/set-employee-status-dialog';
import { RemoveEmployeeDialog } from '@/components/supervisor/employees/remove-employee-dialog';

const EMPLOYMENT_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'regular', label: 'Regular' },
  { value: 'contractual', label: 'Contractual' },
  { value: 'part_time', label: 'Part Time' },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

/**
 * POS-PERF-P40 — formerly "Employees". Lists supervisor accounts only (the
 * list query is pinned to role=supervisor). A row opens the existing person
 * page (/admin/employees/[id]) where branch assignment, payroll data and
 * account recovery stay as before. Staff creation, editing and PINs live in
 * the Supervisor console within assigned branches; no staff record was
 * changed by this rename.
 */
export default function SupervisorListPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [employmentType, setEmploymentType] = useState('all');
  const [status, setStatus] = useState('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeResponse | null>(null);
  const [statusTarget, setStatusTarget] = useState<EmployeeResponse | null>(null);
  const [removeTarget, setRemoveTarget] = useState<EmployeeResponse | null>(null);

  const { data, isLoading, isError, refetch } = useEmployees({
    role: 'supervisor',
    employmentType: employmentType === 'all' ? undefined : (employmentType as EmploymentType),
    isActive: status === 'all' ? undefined : status === 'true',
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<EmployeeResponse>[] = [
    {
      id: 'name',
      header: 'Supervisor',
      cell: ({ row }) => (
        <div className="min-w-[10rem]">
          <p className="font-medium">
            {row.original.first_name} {row.original.last_name}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{row.original.employee_id}</p>
        </div>
      ),
    },
    {
      // POS-PERF-P47 — explicit Edit / Status / Delete (the server enforces
      // the same Super-Admin-only rule; Delete offers Deactivate instead when
      // the supervisor has any history).
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const supervisor = row.original;
        const fullName = `${supervisor.first_name} ${supervisor.last_name}`;
        const stop = (action: () => void) => (event: MouseEvent) => {
          event.stopPropagation();
          action();
        };
        return (
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={stop(() => setEditing(supervisor))} aria-label={`Edit ${fullName}`} data-row-action={`edit:${supervisor.id}`}>
              <Pencil className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="hidden sm:inline">Edit</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={stop(() => setStatusTarget(supervisor))}
              aria-label={`Change status for ${fullName}`}
              data-row-action={`status:${supervisor.id}`}
            >
              <UserCog className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="hidden sm:inline">Status</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={stop(() => setRemoveTarget(supervisor))}
              aria-label={`Delete or deactivate ${fullName}`}
              data-row-action={`remove:${supervisor.id}`}
            >
              <Trash2 className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </div>
        );
      },
    },
    { accessorKey: 'email', header: 'Email' },
    {
      id: 'branches',
      header: 'Assigned Branches',
      cell: ({ row }) =>
        row.original.branch_assignments.length > 0 ? (
          <span className="block max-w-[16rem] truncate" title={row.original.branch_assignments.map((a) => a.branch_name).join(', ')}>
            {row.original.branch_assignments.map((assignment) => assignment.branch_name).join(', ')}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        ),
    },
    {
      accessorKey: 'is_active',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.is_active ? 'active' : 'inactive'} type="employee" />,
    },
    {
      id: 'last_login',
      header: 'Last Login',
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.last_login_at ? formatDateTime(row.original.last_login_at) : 'Never'}</span>,
    },
  ];

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="app-title font-bold">Supervisors</h1>
          <p className="text-sm text-muted-foreground">
            Supervisor accounts and their branches. Staff, their PINs and staff deletion are managed from the Supervisor console.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Add Supervisor
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Search name, email, or ID..."
          className="w-full sm:max-w-xs"
        />
        <Select
          value={employmentType}
          onValueChange={(value) => {
            setEmploymentType(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-full sm:w-[150px]" aria-label="Filter by employment type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EMPLOYMENT_TYPE_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-full sm:w-[150px]" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.employees ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(supervisor) => router.push(`/admin/employees/${supervisor.id}`)}
        emptyState={<EmptyState title="No supervisors yet" description="Add a supervisor and assign their branches." />}
      />

      <AddSupervisorDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editing && (
        <SupervisorEditEmployeeDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            refocusRowAction(`edit:${editing.id}`);
            setEditing(null);
          }}
          employee={editing}
        />
      )}
      {statusTarget && (
        <SetEmployeeStatusDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            refocusRowAction(`status:${statusTarget.id}`);
            setStatusTarget(null);
          }}
          employee={statusTarget}
        />
      )}
      {removeTarget && (
        <RemoveEmployeeDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            refocusRowAction(`remove:${removeTarget.id}`);
            setRemoveTarget(null);
          }}
          employee={removeTarget}
        />
      )}
    </div>
  );
}
