'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import { ROLES, type EmployeeResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { formatDateTime } from '@/lib/utils';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useStaffPinStatus } from '@/hooks/queries/use-staff-pin';
import { SupervisorCreateEmployeeDialog } from '@/components/supervisor/employees/create-employee-dialog';
import { SupervisorEditEmployeeDialog } from '@/components/supervisor/employees/edit-employee-dialog';
import { SetEmployeeStatusDialog } from '@/components/supervisor/employees/set-employee-status-dialog';
import { ManageStaffPinDialog } from '@/components/supervisor/employees/manage-staff-pin-dialog';

/** Inventory/POS PIN status cell — one query per staff row, enabled only for staff (PIN never applies to supervisor/branch/admin rows). */
function PinStatusCell({ employee }: { employee: EmployeeResponse }) {
  const isStaff = employee.role === ROLES.STAFF;
  const status = useStaffPinStatus(employee.id, isStaff);
  if (!isStaff) return <span className="text-muted-foreground">—</span>;
  if (status.isLoading) return <span className="text-xs text-muted-foreground">Loading…</span>;
  if (status.data?.has_pin && status.data.is_active) return <Badge variant="active">Active</Badge>;
  if (status.data?.has_pin && !status.data.is_active) return <Badge variant="secondary">Inactive</Badge>;
  return <Badge variant="outline">Not Set</Badge>;
}

/**
 * Shared body behind both `/supervisor/employees` and `/branch/employees` —
 * the backend already scopes GET /api/employees to the caller's accessible
 * branches and excludes super_admin rows for any non-admin role (see
 * employees.service.ts's getAllEmployees), so this doesn't need to pass a
 * branch filter itself for either route.
 */
export function EmployeesList({ basePath }: { basePath: string }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<EmployeeResponse | null>(null);
  const [statusEmployee, setStatusEmployee] = useState<EmployeeResponse | null>(null);
  const [pinEmployee, setPinEmployee] = useState<EmployeeResponse | null>(null);

  const { data, isLoading, isError, refetch } = useEmployees({ search: search || undefined, limit: 100 });

  const columns: ColumnDef<EmployeeResponse>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => `${row.original.first_name} ${row.original.last_name}`,
    },
    {
      accessorKey: 'position',
      header: 'Position',
      cell: ({ row }) => row.original.position ?? '—',
    },
    {
      id: 'pin_status',
      header: 'Inventory/POS PIN',
      cell: ({ row }) => <PinStatusCell employee={row.original} />,
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
              <DropdownMenuItem onClick={() => router.push(`${basePath}/employees/${employee.id}`)}>View</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditingEmployee(employee)}>Edit</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusEmployee(employee)}>Change Status</DropdownMenuItem>
              {employee.role === ROLES.STAFF && (
                <DropdownMenuItem onClick={() => setPinEmployee(employee)}>Manage Inventory/POS PIN</DropdownMenuItem>
              )}
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
          <p className="text-sm text-muted-foreground">Employees assigned to your branch.</p>
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
        onRowClick={(employee) => router.push(`${basePath}/employees/${employee.id}`)}
        emptyState={<EmptyState title="No employees" description="No employees are assigned to your branch yet." />}
      />

      <SupervisorCreateEmployeeDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editingEmployee && (
        <SupervisorEditEmployeeDialog open onOpenChange={(open) => !open && setEditingEmployee(null)} employee={editingEmployee} />
      )}
      {statusEmployee && (
        <SetEmployeeStatusDialog open onOpenChange={(open) => !open && setStatusEmployee(null)} employee={statusEmployee} />
      )}
      {pinEmployee && <ManageStaffPinDialog open onOpenChange={(open) => !open && setPinEmployee(null)} employee={pinEmployee} />}
    </div>
  );
}
