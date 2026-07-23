'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { PriceOverrideResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency } from '@/lib/utils';
import { usePriceOverrides, usePriceOverridesRealtimeSync } from '@/hooks/queries/use-price-overrides';
import { ReviewPriceOverrideDialog } from '@/components/admin/approvals/review-price-override-dialog';

const STATUS_FILTERS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
] as const;

const STATUS_BADGE_VARIANT: Record<string, 'pending' | 'active' | 'critical'> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'critical',
};

export default function PriceOverridesApprovalPage() {
  const [status, setStatus] = useState<string>('pending');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [reviewing, setReviewing] = useState<PriceOverrideResponse | null>(null);

  usePriceOverridesRealtimeSync();

  const { data, isLoading, isError, refetch } = usePriceOverrides({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<PriceOverrideResponse>[] = [
    { accessorKey: 'branch_name', header: 'Requesting Branch' },
    {
      id: 'variant',
      header: 'Product Variant',
      cell: ({ row }) => `${row.original.product_name} (${row.original.variant_name})`,
    },
    { id: 'master_price', header: 'Current Price', cell: ({ row }) => formatCurrency(row.original.master_price) },
    { id: 'requested_price', header: 'Requested Price', cell: ({ row }) => formatCurrency(row.original.requested_price) },
    {
      id: 'difference',
      header: 'Difference',
      cell: ({ row }) => {
        const diff = row.original.requested_price - row.original.master_price;
        return <span className={diff >= 0 ? 'text-success' : 'text-destructive'}>{diff >= 0 ? '+' : ''}{formatCurrency(diff)}</span>;
      },
    },
    { accessorKey: 'requested_by_name', header: 'Requested By' },
    {
      id: 'reason',
      header: 'Reason',
      cell: ({ row }) => <span className="line-clamp-1 max-w-xs text-muted-foreground">{row.original.request_reason}</span>,
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <Badge variant={STATUS_BADGE_VARIANT[row.original.status]}>{row.original.status}</Badge> },
    {
      id: 'actions',
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          disabled={row.original.status !== 'pending'}
          onClick={(event) => {
            event.stopPropagation();
            setReviewing(row.original);
          }}
        >
          Review
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Price Override Approvals</h1>
        <p className="text-sm text-muted-foreground">Review branch pricing override requests submitted by supervisors.</p>
      </div>

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
        onRowClick={(override) => override.status === 'pending' && setReviewing(override)}
        emptyState={<EmptyState title="No price overrides" description="No supervisor price override requests match this filter." />}
      />

      {reviewing && <ReviewPriceOverrideDialog open onOpenChange={(open) => !open && setReviewing(null)} override={reviewing} />}
    </div>
  );
}
