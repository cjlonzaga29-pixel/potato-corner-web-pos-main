'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ROLE_LABELS, type EmployeeResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useEmployees } from '@/hooks/queries/use-employees';

/**
 * Read-only — no create/edit/deactivate actions and no government ID
 * access anywhere on this page. The backend already scopes GET
 * /api/employees to the supervisor's assigned branches and excludes
 * super_admin rows (see employees.service.ts's getAllEmployees), so this
 * page doesn't need to pass a branch filter itself.
 */
export default function SupervisorEmployeeListPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');

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
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Branch Staff</h1>
        <p className="text-sm text-muted-foreground">Employees assigned to your branches. Contact a Super Admin for changes.</p>
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
    </div>
  );
}
