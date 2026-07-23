'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { MoreHorizontal, Plus } from 'lucide-react';
import type { BranchResponse, BranchStatus } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { useBranches, useBranchRealtimeSync } from '@/hooks/queries/use-branches';
import { CreateBranchDialog } from '@/components/admin/branches/create-branch-dialog';
import { EditBranchDialog } from '@/components/admin/branches/edit-branch-dialog';
import { ChangeStatusDialog } from '@/components/admin/branches/change-status-dialog';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'closed', label: 'Closed' },
];

export default function BranchListPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<BranchResponse | null>(null);
  const [statusBranch, setStatusBranch] = useState<BranchResponse | null>(null);

  useBranchRealtimeSync();

  const { data, isLoading, isError, refetch } = useBranches({
    status: status === 'all' ? undefined : (status as BranchStatus),
    city: city || undefined,
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  // Backend only supports filtering + pagination (see branches.router.ts's
  // GET /api/branches query params) — there's no sort param, so these
  // headers are plain, not the sortable DataTableColumnHeader.
  const columns: ColumnDef<BranchResponse>[] = [
    { accessorKey: 'code', header: 'Branch Code' },
    { accessorKey: 'name', header: 'Branch Name' },
    { accessorKey: 'city', header: 'City' },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    { accessorKey: 'activeSupervisorCount', header: 'Active Supervisors' },
    { accessorKey: 'activeStaffCount', header: 'Active Staff' },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(event) => event.stopPropagation()}
              aria-label="Branch actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onClick={() => router.push(`/admin/branches/${row.original.id}`)}>View</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditingBranch(row.original)}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setStatusBranch(row.original)}>Change Status</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Branch Management</h1>
          <p className="text-sm text-muted-foreground">Manage branches, GPS settings, and supervisor assignments.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Branch
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Search name or code..."
          className="max-w-xs"
        />
        <Input
          placeholder="Filter by city"
          value={city}
          onChange={(event) => {
            setCity(event.target.value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          className="max-w-[180px]"
        />
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
        data={data?.branches ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(branch) => router.push(`/admin/branches/${branch.id}`)}
        emptyState={<EmptyState title="No branches yet" description="Create your first branch to get started." />}
      />

      <CreateBranchDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editingBranch && (
        <EditBranchDialog open onOpenChange={(open) => !open && setEditingBranch(null)} branch={editingBranch} />
      )}
      {statusBranch && (
        <ChangeStatusDialog open onOpenChange={(open) => !open && setStatusBranch(null)} branch={statusBranch} />
      )}
    </div>
  );
}
