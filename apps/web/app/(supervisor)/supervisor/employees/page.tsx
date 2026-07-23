'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import { ROLE_LABELS, type EmployeeResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { SupervisorCreateEmployeeDialog } from '@/components/supervisor/employees/create-employee-dialog';
import { SupervisorEditEmployeeDialog } from '@/components/supervisor/employees/edit-employee-dialog';
import { SupervisorDeactivateEmployeeDialog } from '@/components/supervisor/employees/deactivate-employee-dialog';
import { SupervisorResetPasswordDialog } from '@/components/supervisor/employees/reset-password-dialog';

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

/**
 * Supervisors manage employees assigned to their own branches: create,
 * edit, deactivate/reactivate, and reset passwords. The backend already
 * scopes GET /api/employees to the supervisor's assigned branches and
 * excludes super_admin rows (see employees.service.ts's getAllEmployees),
 * so this page doesn't need to pass a branch filter itself.
 */
export default function SupervisorEmployeeListPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<EmployeeResponse | null>(null);
  const [deactivatingEmployee, setDeactivatingEmployee] = useState<EmployeeResponse | null>(null);
  const [resettingEmployee, setResettingEmployee] = useState<EmployeeResponse | null>(null);

  const { data, isLoading, isError, refetch } = useEmployees({ search: search || undefined, limit: 100 });

  const columns: ColumnDef<EmployeeResponse>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => `${row.original.first_name} ${row.original.last_name}`,
    },
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
              <DropdownMenuItem onClick={() => router.push(`/supervisor/employees/${employee.id}`)}>View</DropdownMenuItem>
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
          <h1 className="text-2xl font-bold">Branch Staff</h1>
          <p className="text-sm text-muted-foreground">Employees assigned to your branches.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Employee
        </Button>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Search by name..." className="max-w-xs" />

      <DataTable
        columns={columns}
        data={data?.employees ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        onRowClick={(employee) => router.push(`/supervisor/employees/${employee.id}`)}
        emptyState={<EmptyState title="No employees" description="No employees are assigned to your branches yet." />}
      />

      <SupervisorCreateEmployeeDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editingEmployee && (
        <SupervisorEditEmployeeDialog open onOpenChange={(open) => !open && setEditingEmployee(null)} employee={editingEmployee} />
      )}
      {deactivatingEmployee && (
        <SupervisorDeactivateEmployeeDialog
          open
          onOpenChange={(open) => !open && setDeactivatingEmployee(null)}
          employee={deactivatingEmployee}
        />
      )}
      {resettingEmployee && (
        <SupervisorResetPasswordDialog open onOpenChange={(open) => !open && setResettingEmployee(null)} employee={resettingEmployee} />
      )}
    </div>
  );
}
