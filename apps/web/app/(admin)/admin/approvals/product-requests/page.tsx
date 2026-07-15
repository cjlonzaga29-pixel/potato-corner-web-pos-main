'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ProductRequestResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatDateTime } from '@/lib/utils';
import { useProductRequests } from '@/hooks/queries/use-product-requests';
import { ReviewProductRequestDialog } from '@/components/admin/approvals/review-product-request-dialog';

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

export default function ProductRequestsApprovalPage() {
  const [status, setStatus] = useState<string>('pending');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [reviewing, setReviewing] = useState<ProductRequestResponse | null>(null);

  const { data, isLoading, isError, refetch } = useProductRequests({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ProductRequestResponse>[] = [
    { accessorKey: 'branch_name', header: 'Requesting Branch' },
    { accessorKey: 'proposed_name', header: 'Proposed Name' },
    { accessorKey: 'requested_by_name', header: 'Requested By' },
    { id: 'created_at', header: 'Requested At', cell: ({ row }) => formatDateTime(row.original.created_at) },
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
        <h1 className="text-2xl font-bold">Product Request Approvals</h1>
        <p className="text-sm text-muted-foreground">Review new-product requests submitted by supervisors for their branches.</p>
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
        data={data?.requests ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(request) => request.status === 'pending' && setReviewing(request)}
        emptyState={<EmptyState title="No product requests" description="No supervisor product requests match this filter." />}
      />

      {reviewing && (
        <ReviewProductRequestDialog open onOpenChange={(open) => !open && setReviewing(null)} request={reviewing} />
      )}
    </div>
  );
}
