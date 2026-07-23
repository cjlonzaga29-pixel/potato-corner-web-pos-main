'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ProductResponse } from '@potato-corner/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useProducts } from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';
import { BranchExclusiveBadge } from '@/components/admin/products/branch-exclusive-badge';

const STATUS_FILTERS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'temporarily_unavailable', label: 'Temporarily Unavailable' },
  { value: 'discontinued', label: 'Discontinued' },
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
  const [status, setStatus] = useState<string>('all');
  const [seasonal, setSeasonal] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useProducts({
    status: status === 'all' ? undefined : (status as ProductResponse['status']),
    category: category || undefined,
    isSeasonal: seasonal === 'all' ? undefined : seasonal === 'true',
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ProductResponse>[] = [
    {
      id: 'image',
      header: '',
      cell: ({ row }) =>
        row.original.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- small thumbnail from Supabase Storage, not worth Next/Image config here
          <img src={row.original.image_url} alt="" className="h-10 w-10 rounded-md object-cover" />
        ) : (
          <div className="h-10 w-10 rounded-md bg-muted" />
        ),
    },
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
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Product Catalog</h1>
        <p className="text-sm text-muted-foreground">Manage the global product catalog, variants, and flavor pricing.</p>
      </div>

      <p className="rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
        New products come from a supervisor&apos;s product request — review pending requests under Product Requests.
      </p>

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
        emptyState={<EmptyState title="No products yet" description="Products are created by approving a supervisor's product request." />}
      />
    </div>
  );
}
