'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Pencil, Trash2 } from 'lucide-react';
import type { ProductOptionGroupResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useDeleteProductOptionGroup, useProductOptionGroups } from '@/hooks/queries/use-product-options';
import { CreateOptionGroupDialog } from '@/components/admin/product-options/create-option-group-dialog';

const ACTIVE_FILTERS = [
  { value: 'all', label: 'All Option Groups' },
  { value: 'true', label: 'Active Only' },
  { value: 'false', label: 'Inactive Only' },
] as const;

export default function ProductOptionsPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductOptionGroupResponse | null>(null);
  const deleteGroup = useDeleteProductOptionGroup();

  const { data, isLoading, isError, refetch } = useProductOptionGroups({
    isActive: active === 'all' ? undefined : active === 'true',
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ProductOptionGroupResponse>[] = [
    { accessorKey: 'code', header: 'Code' },
    { accessorKey: 'name', header: 'Name' },
    {
      accessorKey: 'selection_type',
      header: 'Selection',
      cell: ({ row }) => (row.original.selection_type === 'SINGLE' ? 'Single' : 'Multiple'),
    },
    {
      id: 'range',
      header: 'Min / Max',
      cell: ({ row }) => `${row.original.min_selections} / ${row.original.max_selections ?? '∞'}`,
    },
    { accessorKey: 'option_count', header: 'Options' },
    {
      accessorKey: 'required',
      header: 'Required',
      cell: ({ row }) => <Badge variant={row.original.required ? 'active' : 'inactive'}>{row.original.required ? 'Yes' : 'No'}</Badge>,
    },
    {
      accessorKey: 'is_active',
      header: 'Status',
      cell: ({ row }) => <Badge variant={row.original.is_active ? 'active' : 'inactive'}>{row.original.is_active ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Edit ${row.original.name}`}
            onClick={(event) => {
              event.stopPropagation();
              router.push(`/admin/product-options/${row.original.id}`);
            }}
          >
            <Pencil className="mr-1 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Delete ${row.original.name}`}
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(row.original);
            }}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ];

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    await deleteGroup.mutateAsync(deleteTarget.id);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Product Options</h1>
          <p className="text-sm text-muted-foreground">Generic Option Groups (Flavor, Size, Add-ons) and their Options.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">New Option Group</Button>
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
        <Select
          value={active}
          onValueChange={(value) => {
            setActive(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIVE_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.option_groups ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(group) => router.push(`/admin/product-options/${group.id}`)}
        emptyState={
          <EmptyState title="No option groups yet" description="Create your first option group, e.g. Flavor or Add-ons." />
        }
      />

      <CreateOptionGroupDialog open={createOpen} onOpenChange={setCreateOpen} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Product Option Group?"
        description={
          deleteTarget && (
            <>
              This permanently deletes the option group, its options, and unused mappings. This action cannot be undone.
              <br />
              <br />
              <span className="font-medium text-foreground">{deleteTarget.name}</span> ({deleteTarget.code}) —{' '}
              {deleteTarget.option_count} option{deleteTarget.option_count === 1 ? '' : 's'}
            </>
          )
        }
        confirmLabel="Delete Permanently"
        variant="danger"
        onConfirm={handleDeleteConfirmed}
      />
    </div>
  );
}
