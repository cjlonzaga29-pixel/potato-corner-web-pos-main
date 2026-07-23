'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { MoreHorizontal } from 'lucide-react';
import type { ProductResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { formatDateTime } from '@/lib/utils';
import { useProducts, useDeleteProduct } from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';
import { BranchExclusiveBadge } from '@/components/admin/products/branch-exclusive-badge';
import { EditProductDialog } from '@/components/admin/products/edit-product-dialog';
import { ChangeProductStatusDialog } from '@/components/admin/products/change-product-status-dialog';
import { UploadProductImageDialog } from '@/components/admin/products/upload-product-image-dialog';

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
  const [rowAction, setRowAction] = useState<{ product: ProductResponse; dialog: 'edit' | 'status' | 'image' } | null>(null);

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
              aria-label="Product actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onClick={() => router.push(`/admin/products/${row.original.id}`)}>View</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRowAction({ product: row.original, dialog: 'edit' })}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRowAction({ product: row.original, dialog: 'status' })}>Change Status</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRowAction({ product: row.original, dialog: 'image' })}>Upload Image</DropdownMenuItem>
            <DeleteProductAction product={row.original} />
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Product Catalog</h1>
        <p className="text-sm text-muted-foreground">Manage the global product catalog, variants, and flavor pricing.</p>
      </div>

      <p className="rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
        New products come from a supervisor&apos;s product request — review pending requests under Product Requests. From here you can
        edit, change status, or upload an image for any existing product.
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

      {rowAction && (
        <>
          <EditProductDialog
            open={rowAction.dialog === 'edit'}
            onOpenChange={(open) => !open && setRowAction(null)}
            product={rowAction.product}
          />
          <ChangeProductStatusDialog
            open={rowAction.dialog === 'status'}
            onOpenChange={(open) => !open && setRowAction(null)}
            product={rowAction.product}
          />
          <UploadProductImageDialog
            open={rowAction.dialog === 'image'}
            onOpenChange={(open) => !open && setRowAction(null)}
            productId={rowAction.product.id}
          />
        </>
      )}
    </div>
  );
}

function DeleteProductAction({ product }: { product: ProductResponse }) {
  const [confirming, setConfirming] = useState(false);
  const deleteProduct = useDeleteProduct();

  return (
    <>
      <DropdownMenuItem onClick={() => setConfirming(true)} className="text-destructive">
        Delete
      </DropdownMenuItem>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${product.name}?`}
        description="This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          await deleteProduct.mutateAsync(product.id);
        }}
      />
    </>
  );
}
