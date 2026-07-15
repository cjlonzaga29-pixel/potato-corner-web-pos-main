'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { TransactionResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { ShiftDenominationTable } from '@/components/admin/shifts/shift-denomination-table';
import { ReviewVarianceDialog } from '@/components/admin/shifts/review-variance-dialog';
import { formatCurrency } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useShift, useShiftSummary, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';

const TRANSACTION_STATUS_VARIANT: Record<string, 'active' | 'critical' | 'warning'> = {
  completed: 'active',
  voided: 'critical',
  refunded: 'warning',
};

/**
 * Shared shift-detail body rendered by both the admin (`/admin/shifts/:shiftId`)
 * and supervisor (`/supervisor/cash/:shiftId`) routes. Next.js route groups
 * require one page file per URL, and `middleware.ts` restricts `/admin` to
 * `super_admin` and `/supervisor` to `supervisor`, so each route keeps its own
 * thin page wrapper — this component holds the single copy of the actual logic.
 */
export function ShiftDetailView() {
  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  const params = useParams<{ shiftId: string }>();
  const shiftId = params.shiftId;
  const { user } = useAuth();
  const [reviewing, setReviewing] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data: shift, isLoading: shiftLoading } = useShift(shiftId);
  const { data: summaryData } = useShiftSummary(shiftId);
  // useTransactions is `enabled: Boolean(filters.branch_id)` — passing shift.branch_id
  // once the parent shift has loaded also satisfies branchGuard for a supervisor caller.
  const { data: txData, isLoading: txLoading, isError: txError, refetch: refetchTx } = useTransactions({
    shift_id: shiftId,
    branch_id: shift?.branch_id,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'created_at', header: 'Time', cell: ({ row }) => new Date(row.original.created_at).toLocaleTimeString() },
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    {
      id: 'items',
      header: 'Items',
      cell: ({ row }) => (row.original.items ?? []).map((i) => `${i.quantity}x ${i.product_name}`).join(', '),
    },
    { id: 'payment_method', header: 'Payment', cell: ({ row }) => row.original.payment_method.toUpperCase() },
    { id: 'discount_type', header: 'Discount', cell: ({ row }) => row.original.discount_type ?? '—' },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={TRANSACTION_STATUS_VARIANT[row.original.status]}>{row.original.status}</Badge>,
    },
  ];

  if (shiftLoading) return <p className="p-6 text-sm text-muted-foreground">Loading shift…</p>;
  if (!shift) return <p className="p-6 text-sm text-destructive">Shift not found.</p>;

  const summary = summaryData?.summary;
  const canReview = shift.status === 'flagged' && user?.role === 'super_admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Shift Detail</h1>
          <p className="text-sm text-muted-foreground">{shift.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <ShiftStatusBadge status={shift.status} />
          {canReview && <Button onClick={() => setReviewing(true)}>Review Variance</Button>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Shift Metadata</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><p className="text-xs text-muted-foreground">Branch</p><p className="font-medium">{shift.branch_id}</p></div>
          <div><p className="text-xs text-muted-foreground">Cashier</p><p className="font-medium">{shift.cashier_id}</p></div>
          <div><p className="text-xs text-muted-foreground">Opened At</p><p className="font-medium">{new Date(shift.started_at).toLocaleString()}</p></div>
          <div><p className="text-xs text-muted-foreground">Closed At</p><p className="font-medium">{shift.closed_at ? new Date(shift.closed_at).toLocaleString() : '—'}</p></div>
        </CardContent>
      </Card>

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">EOD Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-muted-foreground">Total Sales</p><p className="font-semibold tabular-nums">{formatCurrency(summary.total_sales)}</p></div>
            <div><p className="text-xs text-muted-foreground">Cash Sales</p><p className="font-semibold tabular-nums">{formatCurrency(summary.cash_sales_total)} ({summary.cash_sales_count})</p></div>
            <div><p className="text-xs text-muted-foreground">GCash Sales</p><p className="font-semibold tabular-nums">{formatCurrency(summary.gcash_sales_total)} ({summary.gcash_sales_count})</p></div>
            <div><p className="text-xs text-muted-foreground">Total Transactions</p><p className="font-semibold tabular-nums">{summary.total_transaction_count}</p></div>
            <div><p className="text-xs text-muted-foreground">Voided</p><p className="font-semibold tabular-nums">{summary.voided_count}</p></div>
            <div><p className="text-xs text-muted-foreground">Refunded</p><p className="font-semibold tabular-nums">{summary.refunded_count}</p></div>
            <div><p className="text-xs text-muted-foreground">Total Discounts</p><p className="font-semibold tabular-nums">{formatCurrency(summary.total_discount_amount)}</p></div>
            <div><p className="text-xs text-muted-foreground">PWD/SC Transactions</p><p className="font-semibold tabular-nums">{summary.pwd_sc_transaction_count}</p></div>
            {summary.actual_cash !== null && (
              <>
                <div><p className="text-xs text-muted-foreground">Expected Cash</p><p className="font-semibold tabular-nums">{formatCurrency(summary.expected_cash)}</p></div>
                <div><p className="text-xs text-muted-foreground">Actual Cash</p><p className="font-semibold tabular-nums">{formatCurrency(summary.actual_cash)}</p></div>
                <div><p className="text-xs text-muted-foreground">Variance</p><p className={`font-semibold tabular-nums ${summary.variance !== 0 ? 'text-destructive' : ''}`}>{formatCurrency(summary.variance ?? 0)}</p></div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {shift.status === 'flagged' && (
        <Card className="border-orange-400">
          <CardHeader>
            <CardTitle className="text-sm text-orange-600">Pending Variance Review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Cashier&apos;s explanation: {shift.variance_explanation}</p>
            {!canReview && <p className="text-xs text-muted-foreground">Only a super admin can approve or reject this variance.</p>}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Opening Count</CardTitle></CardHeader>
          <CardContent><ShiftDenominationTable denominations={shift.denominations ?? []} phase="opening" /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Closing Count</CardTitle></CardHeader>
          <CardContent><ShiftDenominationTable denominations={shift.denominations ?? []} phase="closing" /></CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Transactions</h2>
        <DataTable
          columns={columns}
          data={txData?.transactions ?? []}
          isLoading={txLoading}
          isError={txError}
          onRetry={() => void refetchTx()}
          pagination={pagination}
          onPaginationChange={setPagination}
          rowCount={txData?.total ?? 0}
          emptyState={<EmptyState title="No transactions" description="No transactions were recorded on this shift." />}
        />
      </div>

      {canReview && <ReviewVarianceDialog open={reviewing} onOpenChange={setReviewing} shift={shift} />}
    </div>
  );
}
