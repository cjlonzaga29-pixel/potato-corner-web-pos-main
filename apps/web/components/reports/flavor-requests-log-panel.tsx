'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { FlavorRequestResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { formatDateTime } from '@/lib/utils';
import { useFlavorRequests } from '@/hooks/queries/use-flavor-requests';

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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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
  { id: 'reviewed_by_name', header: 'Reviewed By', cell: ({ row }) => row.original.reviewed_by_name ?? '—' },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={STATUS_BADGE_VARIANT[row.original.status]}>{capitalize(row.original.status)}</Badge>
    ),
  },
];

/** Read-only history — reviewing pending requests still happens at /admin/approvals/flavor-requests. */
export function FlavorRequestsLogPanel() {
  const [status, setStatus] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useFlavorRequests({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">Flavor Request History</h3>

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
        emptyState={<EmptyState title="No flavor requests" description="No supervisor flavor requests match this filter." />}
      />
    </div>
  );
}
