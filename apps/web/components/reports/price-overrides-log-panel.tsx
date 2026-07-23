'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { PriceOverrideResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency } from '@/lib/utils';
import { usePriceOverrides } from '@/hooks/queries/use-price-overrides';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
] as const;

const STATUS_BADGE_VARIANT: Record<string, 'pending' | 'active' | 'critical'> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'critical',
};

const columns: ColumnDef<PriceOverrideResponse>[] = [
  { accessorKey: 'branch_name', header: 'Requesting Branch' },
  {
    id: 'variant',
    header: 'Product Variant',
    cell: ({ row }) => `${row.original.product_name} (${row.original.variant_name})`,
  },
  { id: 'master_price', header: 'Current Price', cell: ({ row }) => formatCurrency(row.original.master_price) },
  { id: 'requested_price', header: 'Requested Price', cell: ({ row }) => formatCurrency(row.original.requested_price) },
  { accessorKey: 'requested_by_name', header: 'Requested By' },
  { id: 'reviewed_by_name', header: 'Reviewed By', cell: ({ row }) => row.original.reviewed_by_name ?? '—' },
  { id: 'status', header: 'Status', cell: ({ row }) => <Badge variant={STATUS_BADGE_VARIANT[row.original.status]}>{row.original.status}</Badge> },
];

/** Read-only history — reviewing pending overrides still happens at /admin/approvals/price-overrides. */
export function PriceOverridesLogPanel() {
  const [status, setStatus] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = usePriceOverrides({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">Price Override History</h3>

      <Select
        value={status}
        onValueChange={(value) => {
          setStatus(value);
          setPagination((prev) => ({ ...prev, pageIndex: 0 }));
        }}
      >
        <SelectTrigger className="w-[180px]">
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

      <DataTable
        columns={columns}
        data={data?.overrides ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        emptyState={<EmptyState title="No price overrides" description="No supervisor price override requests match this filter." />}
      />
    </div>
  );
}
