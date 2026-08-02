'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Pencil } from 'lucide-react';
import type { ProductOptionGroupResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useProductOptionGroups } from '@/hooks/queries/use-product-options';
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
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Product Options</h1>
          <p className="text-sm text-muted-foreground">Generic Option Groups (Flavor, Size, Add-ons) and their Options.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New Option Group</Button>
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
    </div>
  );
}
