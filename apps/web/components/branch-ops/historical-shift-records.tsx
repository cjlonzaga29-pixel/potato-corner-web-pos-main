'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { ShiftResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useShifts } from '@/hooks/queries/use-shifts';

function varianceApprovalLabel(approved: boolean | null): { label: string; variant: 'active' | 'critical' | 'pending' } {
  if (approved === true) return { label: 'Approved', variant: 'active' };
  if (approved === false) return { label: 'Rejected', variant: 'critical' };
  return { label: 'Pending', variant: 'pending' };
}

const columns: ColumnDef<ShiftResponse>[] = [
  { id: 'started_at', header: 'Started', cell: ({ row }) => formatDateTime(row.original.started_at) },
  {
    id: 'closed_at',
    header: 'Closed',
    cell: ({ row }) => (row.original.closed_at ? formatDateTime(row.original.closed_at) : 'Still open'),
  },
  { id: 'status', header: 'Status', cell: ({ row }) => <ShiftStatusBadge status={row.original.status} /> },
  { id: 'transaction_count', header: 'Transactions', accessorKey: 'transaction_count' },
  { id: 'cash_sales_total', header: 'Cash Sales', cell: ({ row }) => formatCurrency(row.original.cash_sales_total) },
  { id: 'gcash_sales_total', header: 'GCash Sales', cell: ({ row }) => formatCurrency(row.original.gcash_sales_total) },
  { id: 'opening_cash_amount', header: 'Opening Cash', cell: ({ row }) => formatCurrency(row.original.opening_cash_amount) },
  {
    id: 'closing_cash_amount',
    header: 'Actual Closing',
    cell: ({ row }) => (row.original.closing_cash_amount === null ? '—' : formatCurrency(row.original.closing_cash_amount)),
  },
  {
    id: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => {
      const variance = row.original.cash_variance;
      if (variance === null) return '—';
      return <span className={variance < 0 ? 'text-destructive' : ''}>{formatCurrency(variance)}</span>;
    },
  },
  {
    id: 'variance_approved',
    header: 'Approval',
    cell: ({ row }) => {
      const { label, variant } = varianceApprovalLabel(row.original.variance_approved);
      return <Badge variant={variant}>{label}</Badge>;
    },
  },
];

/**
 * Read-only audit view of pre-CR-004 Shift/cash-reconciliation data (Reports
 * §8-9) — shifts are auto-managed server-side now (shiftGuard) and no longer
 * a branch operation, so this is deliberately not reachable as a primary
 * Reports tab, has no export, and offers no approve/reject action. Kept
 * under Activity Logs solely so historical records stay auditable.
 */
export function HistoricalShiftRecords() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const { data, isLoading, isError, refetch } = useShifts({ branch_id: activeBranchId ?? undefined, page: 1, limit: 100 });

  const shifts = (data?.shifts ?? []).filter((s) => {
    if (fromDate && s.started_at < `${fromDate}T00:00:00`) return false;
    if (toDate && s.started_at > `${toDate}T23:59:59.999`) return false;
    return true;
  });

  if (!activeBranchId) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Historical shift and cash-reconciliation records, preserved for audit purposes only. Read-only — not part of normal branch
        operations.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="historical-shift-from">From</Label>
          <Input id="historical-shift-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="historical-shift-to">To</Label>
          <Input id="historical-shift-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>
      <DataTable
        columns={columns}
        data={shifts}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState title="No historical shifts" description="No shift records found for this branch." />}
      />
    </div>
  );
}
