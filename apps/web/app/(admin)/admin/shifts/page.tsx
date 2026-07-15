'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ShiftResponse } from '@potato-corner/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { formatCurrency } from '@/lib/utils';
import { useShifts } from '@/hooks/queries/use-shifts';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'flagged', label: 'Pending Review' },
] as const;

/** super_admin sees every branch — GET /api/cash skips branchGuard entirely for this role, so no branch_id filter is sent. */
export default function AdminShiftsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useShifts({
    status: status === 'all' ? undefined : (status as 'active' | 'closed' | 'flagged'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ShiftResponse>[] = [
    { id: 'branch', header: 'Branch', accessorKey: 'branch_id' },
    { id: 'opened_by', header: 'Opened By', accessorKey: 'opened_by' },
    {
      id: 'started_at',
      header: 'Opened At',
      cell: ({ row }) => new Date(row.original.started_at).toLocaleString(),
    },
    {
      id: 'closed_at',
      header: 'Closed At',
      cell: ({ row }) => (row.original.closed_at ? new Date(row.original.closed_at).toLocaleString() : '—'),
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <ShiftStatusBadge status={row.original.status} /> },
    {
      id: 'total_sales',
      header: 'Total Sales',
      cell: ({ row }) => formatCurrency(row.original.cash_sales_total + row.original.gcash_sales_total),
    },
    {
      id: 'variance',
      header: 'Variance',
      cell: ({ row }) => {
        const variance = row.original.cash_variance;
        if (variance === null) return '—';
        return <span className={variance === 0 ? '' : 'text-destructive'}>{formatCurrency(variance)}</span>;
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Shifts</h1>
        <p className="text-sm text-muted-foreground">Every shift across every branch. Click a row for the full cash reconciliation detail.</p>
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
        data={data?.shifts ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(shift) => router.push(`/admin/shifts/${shift.id}`)}
        emptyState={<EmptyState title="No shifts" description="No shifts match this filter." />}
      />
    </div>
  );
}
