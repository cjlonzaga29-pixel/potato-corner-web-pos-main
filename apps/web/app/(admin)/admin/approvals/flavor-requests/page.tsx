'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { FlavorRequestResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { formatDateTime } from '@/lib/utils';
import { useFlavorRequests, useFlavorRequestsRealtimeSync } from '@/hooks/queries/use-flavor-requests';
import { ReviewFlavorRequestDialog } from '@/components/admin/approvals/review-flavor-request-dialog';

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

export default function FlavorRequestsApprovalPage() {
  const [status, setStatus] = useState<string>('pending');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [reviewing, setReviewing] = useState<FlavorRequestResponse | null>(null);

  useFlavorRequestsRealtimeSync();

  const { data, isLoading, isError, refetch } = useFlavorRequests({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<FlavorRequestResponse>[] = [
    { accessorKey: 'branch_name', header: 'Requesting Branch' },
    {
      id: 'proposed_name',
      header: 'Proposed Name',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <FlavorColorSwatch colorHex={row.original.proposed_color_hex} />
          <span>{row.original.proposed_name}</span>
        </div>
      ),
    },
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
        <h1 className="text-2xl font-bold">Flavor Request Approvals</h1>
        <p className="text-sm text-muted-foreground">Review new-flavor requests submitted by supervisors for their branches.</p>
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
        emptyState={<EmptyState title="No flavor requests" description="No supervisor flavor requests match this filter." />}
      />

      {reviewing && (
        <ReviewFlavorRequestDialog open onOpenChange={(open) => !open && setReviewing(null)} request={reviewing} />
      )}
    </div>
  );
}
