'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ShiftResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { formatCurrency } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useShifts, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';

/**
 * Shared body behind both `/supervisor/cash` and `/branch/cash`. GET
 * /api/cash requires branch_id for non-super_admin (branchGuard).
 */
export function CashShiftsList({ basePath }: { basePath: string }) {
  useShiftsRealtimeSync();
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useShifts({
    branch_id: activeBranchId ?? undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ShiftResponse>[] = [
    { id: 'opened_by', header: 'Opened By', accessorKey: 'opened_by' },
    { id: 'started_at', header: 'Opened At', cell: ({ row }) => new Date(row.original.started_at).toLocaleString() },
    { id: 'closed_at', header: 'Closed At', cell: ({ row }) => (row.original.closed_at ? new Date(row.original.closed_at).toLocaleString() : '—') },
    { id: 'status', header: 'Status', cell: ({ row }) => <ShiftStatusBadge status={row.original.status} /> },
    { id: 'total_sales', header: 'Total Sales', cell: ({ row }) => formatCurrency(row.original.cash_sales_total + row.original.gcash_sales_total) },
    {
      id: 'variance',
      header: 'Variance',
      cell: ({ row }) => (row.original.cash_variance === null ? '—' : <span className={row.original.cash_variance === 0 ? '' : 'text-destructive'}>{formatCurrency(row.original.cash_variance)}</span>),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its cash shifts.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cash Management</h1>
        <p className="text-sm text-muted-foreground">Shifts for your active branch. Click a row for the full reconciliation detail.</p>
      </div>

      <DataTable
        columns={columns}
        data={data?.shifts ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(shift) => router.push(`${basePath}/cash/${shift.id}`)}
        emptyState={<EmptyState title="No shifts" description="No shifts recorded yet for this branch." />}
      />
    </div>
  );
}
