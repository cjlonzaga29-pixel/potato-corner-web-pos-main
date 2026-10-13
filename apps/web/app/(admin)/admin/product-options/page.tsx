'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Eye } from 'lucide-react';
import type { ProductOptionGroupResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ManagedElsewhereBanner } from '@/components/shared/managed-elsewhere-banner';
import { useProductOptionGroups } from '@/hooks/queries/use-product-options';

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
          aria-label={`View ${row.original.name}`}
          onClick={(event) => {
            event.stopPropagation();
            router.push(`/admin/product-options/${row.original.id}`);
          }}
        >
          <Eye className="mr-1 h-4 w-4" />
          View
        </Button>
      ),
    },
  ];

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="app-title font-bold">Product Options</h1>
          <p className="text-sm text-muted-foreground">Generic Option Groups (Flavor, Size, Add-ons) and their Options.</p>
        </div>
      </div>

      <ManagedElsewhereBanner module="Product Options" managedBy="Supervisor" />

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
        emptyState={<EmptyState title="No option groups yet" description="Option groups are created by Supervisors." />}
      />
    </div>
  );
}
