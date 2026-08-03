'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Pencil } from 'lucide-react';
import type { ProductCategoryResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useProductCategories } from '@/hooks/queries/use-product-categories';
import { CreateCategoryDialog } from '@/components/admin/product-categories/create-category-dialog';
import { EditCategoryDialog } from '@/components/admin/product-categories/edit-category-dialog';

const ACTIVE_FILTERS = [
  { value: 'all', label: 'All Categories' },
  { value: 'true', label: 'Active Only' },
  { value: 'false', label: 'Inactive Only' },
] as const;

export default function ProductCategoriesPage() {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProductCategoryResponse | null>(null);

  const { data, isLoading, isError, refetch } = useProductCategories({
    isActive: active === 'all' ? undefined : active === 'true',
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ProductCategoryResponse>[] = [
    { accessorKey: 'code', header: 'Code' },
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'description', header: 'Description', cell: ({ row }) => row.original.description ?? '—' },
    { accessorKey: 'product_count', header: 'Products' },
    {
      accessorKey: 'is_active',
      header: 'Status',
      cell: ({ row }) => <Badge variant={row.original.is_active ? 'active' : 'inactive'}>{row.original.is_active ? 'Active' : 'Inactive'}</Badge>,
    },
    { id: 'updated_at', header: 'Updated', cell: ({ row }) => formatDateTime(row.original.updated_at) },
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
            setEditing(row.original);
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Product Categories</h1>
          <p className="text-sm text-muted-foreground">Company-owned categories, shared across every branch.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">New Category</Button>
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
        data={data?.categories ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(category) => setEditing(category)}
        emptyState={<EmptyState title="No categories yet" description="Create your first product category to organize the catalog." />}
      />

      <CreateCategoryDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditCategoryDialog category={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </div>
  );
}
