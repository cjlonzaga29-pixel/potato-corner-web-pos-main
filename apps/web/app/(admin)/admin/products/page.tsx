'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus } from 'lucide-react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ProductResponse } from '@potato-corner/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useProducts } from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';
import { BranchExclusiveBadge } from '@/components/admin/products/branch-exclusive-badge';
import { CreateProductDialog } from '@/components/admin/products/create-product-dialog';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
] as const;

const SEASONAL_FILTERS = [
  { value: 'all', label: 'All Products' },
  { value: 'true', label: 'Seasonal Only' },
  { value: 'false', label: 'Regular Only' },
] as const;

export default function ProductCatalogPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<string>('active');
  const [seasonal, setSeasonal] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useProducts({
    status: status === 'all' ? undefined : (status as ProductResponse['status']),
    category: category || undefined,
    isSeasonal: seasonal === 'all' ? undefined : seasonal === 'true',
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ProductResponse>[] = [
    { accessorKey: 'name', header: 'Product' },
    { accessorKey: 'category', header: 'Category', cell: ({ row }) => row.original.category ?? '—' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <ProductStatusBadge status={row.original.status} /> },
    { id: 'seasonal', header: 'Seasonal', cell: ({ row }) => <SeasonalBadge isSeasonal={row.original.is_seasonal} /> },
    {
      id: 'availability',
      header: 'Availability',
      cell: ({ row }) => (
        <BranchExclusiveBadge branchExclusive={row.original.branch_exclusive} exclusiveBranchName={row.original.exclusive_branch_name} />
      ),
    },
    { accessorKey: 'active_variant_count', header: 'Active Variants' },
    { accessorKey: 'active_branch_count', header: 'Active Branches' },
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
            router.push(`/admin/products/${row.original.id}`);
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Product Catalog</h1>
          <p className="text-sm text-muted-foreground">Manage the global product catalog, variants, and flavor pricing.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Product
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Search name or category..."
          className="max-w-xs"
        />
        <SearchInput
          value={category}
          onChange={(value) => {
            setCategory(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Filter by category..."
          className="max-w-[180px]"
        />
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-[190px]">
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
        <Select
          value={seasonal}
          onValueChange={(value) => {
            setSeasonal(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEASONAL_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={data?.products ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(product) => router.push(`/admin/products/${product.id}`)}
        emptyState={<EmptyState title="No products yet" description="Click Create Product to add the first one." />}
      />

      <CreateProductDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
