'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import { ROLE_LABELS, type EmployeeResponse, type EmploymentType, type Role } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/shared/status-badge';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { formatDateTime } from '@/lib/utils';
import { useEmployees, useReactivateEmployee } from '@/hooks/queries/use-employees';
import { CreateEmployeeDialog } from '@/components/admin/employees/create-employee-dialog';
import { EditEmployeeDialog } from '@/components/admin/employees/edit-employee-dialog';
import { DeactivateEmployeeDialog } from '@/components/admin/employees/deactivate-employee-dialog';
import { ResetPasswordDialog } from '@/components/admin/employees/reset-password-dialog';

const ROLE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Roles' },
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'staff', label: 'Staff' },
];

const EMPLOYMENT_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'regular', label: 'Regular' },
  { value: 'contractual', label: 'Contractual' },
  { value: 'part_time', label: 'Part Time' },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

function ReactivateAction({ employeeId }: { employeeId: string }) {
  const [confirming, setConfirming] = useState(false);
  const reactivate = useReactivateEmployee(employeeId);

  return (
    <>
      <DropdownMenuItem onClick={() => setConfirming(true)}>Reactivate</DropdownMenuItem>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reactivate this employee?"
        description="They will be required to set a new password on next login."
        confirmLabel="Reactivate"
        onConfirm={async () => {
          await reactivate.mutateAsync();
        }}
      />
    </>
  );
}

export default function EmployeeListPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [employmentType, setEmploymentType] = useState('all');
  const [status, setStatus] = useState('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<EmployeeResponse | null>(null);
  const [deactivatingEmployee, setDeactivatingEmployee] = useState<EmployeeResponse | null>(null);
  const [resettingEmployee, setResettingEmployee] = useState<EmployeeResponse | null>(null);

  const { data, isLoading, isError, refetch } = useEmployees({
    role: role === 'all' ? undefined : (role as Role),
    employmentType: employmentType === 'all' ? undefined : (employmentType as EmploymentType),
    isActive: status === 'all' ? undefined : status === 'true',
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  // Backend only supports filtering + pagination (see employees.router.ts's
  // GET /api/employees query params) — there's no sort param, so these
  // headers are plain, not the sortable DataTableColumnHeader.
  const columns: ColumnDef<EmployeeResponse>[] = [
    { accessorKey: 'employee_id', header: 'Employee ID', cell: ({ row }) => <span className="font-mono text-xs">{row.original.employee_id}</span> },
    {
      id: 'name',
      header: 'Full Name',
      cell: ({ row }) => `${row.original.first_name} ${row.original.last_name}`,
    },
    { accessorKey: 'email', header: 'Email' },
    {
      accessorKey: 'role',
      header: 'Role',
      cell: ({ row }) => <Badge variant="secondary">{ROLE_LABELS[row.original.role]}</Badge>,
    },
    {
      accessorKey: 'employment_type',
      header: 'Employment Type',
      cell: ({ row }) => <span className="capitalize">{row.original.employment_type.replace('_', ' ')}</span>,
    },
    {
      id: 'branches',
      header: 'Assigned Branches',
      cell: ({ row }) =>
        row.original.branch_assignments.length > 0
          ? row.original.branch_assignments.map((assignment) => assignment.branch_code).join(', ')
          : '—',
    },
    {
      accessorKey: 'is_active',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.is_active ? 'active' : 'inactive'} type="employee" />,
    },
    {
      id: 'last_login',
      header: 'Last Login',
      cell: ({ row }) => (row.original.last_login_at ? formatDateTime(row.original.last_login_at) : 'Never'),
    },
    {
      id: 'actions',
      cell: ({ row }) => {
        const employee = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(event) => event.stopPropagation()}
                aria-label="Employee actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              <DropdownMenuItem onClick={() => router.push(`/admin/employees/${employee.id}`)}>View</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditingEmployee(employee)}>Edit</DropdownMenuItem>
              {employee.is_active ? (
                <DropdownMenuItem onClick={() => setDeactivatingEmployee(employee)} className="text-destructive">
                  Deactivate
                </DropdownMenuItem>
              ) : (
                <ReactivateAction employeeId={employee.id} />
              )}
              <DropdownMenuItem onClick={() => setResettingEmployee(employee)}>Reset Password</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Employee Management</h1>
          <p className="text-sm text-muted-foreground">Manage employee accounts, branch assignments, and access.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Employee
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Search name, email, or employee ID..."
          className="max-w-xs"
        />
        <Select
          value={role}
          onValueChange={(value) => {
            setRole(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={employmentType}
          onValueChange={(value) => {
            setEmploymentType(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-[150px]">
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
          <SelectTrigger className="w-[140px]">
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
        onRowClick={(employee) => router.push(`/admin/employees/${employee.id}`)}
        emptyState={<EmptyState title="No employees yet" description="Create your first employee to get started." />}
      />

      <CreateEmployeeDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editingEmployee && (
        <EditEmployeeDialog open onOpenChange={(open) => !open && setEditingEmployee(null)} employee={editingEmployee} />
      )}
      {deactivatingEmployee && (
        <DeactivateEmployeeDialog
          open
          onOpenChange={(open) => !open && setDeactivatingEmployee(null)}
          employee={deactivatingEmployee}
        />
      )}
      {resettingEmployee && (
        <ResetPasswordDialog open onOpenChange={(open) => !open && setResettingEmployee(null)} employee={resettingEmployee} />
      )}
    </div>
  );
}
