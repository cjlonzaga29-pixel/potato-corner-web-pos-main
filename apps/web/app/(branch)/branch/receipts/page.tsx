'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Receipt as ReceiptIcon } from 'lucide-react';
import type { TransactionResponse } from '@potato-corner/shared';
import { ROLES } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { ViewPaymentProofDialog } from '@/components/shared/transactions/view-payment-proof-dialog';
import { ViewTransactionDetailDialog } from '@/components/shared/transactions/view-transaction-detail-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useTransaction, useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useAttendanceByEmployee } from '@/hooks/queries/use-attendance';
import { useBranch } from '@/hooks/queries/use-branches';
import { useEmployee } from '@/hooks/queries/use-employees';
import { formatDateTime } from '@/lib/utils';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

const PAYMENT_METHOD_LABEL: Record<TransactionResponse['payment_method'], string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  other: 'Other',
};

/** Branch/staff-facing receipt lookup/reprint — the (branch) nav's "Receipts" item. Scoped to the cashier's own branch, most recent first. */
export default function ReceiptsPage() {
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proofTransactionId, setProofTransactionId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useTransactionsRealtimeSync();
  const { data, isLoading, isError, refetch } = useTransactions({
    branch_id: branchId,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });
  const { data: selectedTransaction } = useTransaction(selectedId);
  const { data: detailTransaction } = useTransaction(detailId);
  const { data: branch } = useBranch(branchId);
  const { data: cashier } = useEmployee(detailTransaction?.cashier_id);
  const attendanceWindow = detailTransaction
    ? (() => {
        const day = detailTransaction.created_at.slice(0, 10);
        const from = new Date(`${day}T00:00:00.000Z`);
        from.setUTCDate(from.getUTCDate() - 1);
        const to = new Date(`${day}T00:00:00.000Z`);
        to.setUTCDate(to.getUTCDate() + 1);
        return { from: from.toISOString(), to: to.toISOString() };
      })()
    : undefined;
  // The attendance-session cross-reference is audit context (verifying a
  // *coworker's* clock-in window), not a cashier duty — GET
  // /api/attendance/employee/:id is self-scoped server-side for STAFF, so a
  // staff viewer would 403 on any receipt but their own. Skip the fetch
  // entirely for staff rather than depend on that per-row coincidence.
  const { data: attendanceData } = useAttendanceByEmployee(user?.role === ROLES.STAFF ? undefined : detailTransaction?.cashier_id, {
    ...attendanceWindow,
    limit: 100,
  });

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'receipt_number', header: 'Receipt No.', cell: ({ row }) => row.original.receipt_number },
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'payment_method', header: 'Payment', cell: ({ row }) => PAYMENT_METHOD_LABEL[row.original.payment_method] },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatPeso(row.original.total_amount) },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
    {
      id: 'payment_proof',
      header: 'Payment Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (txn.payment_method === 'cash') return <span className="text-xs text-muted-foreground">—</span>;
        if (!txn.has_payment_proof) return <span className="text-xs text-muted-foreground">No payment proof uploaded</span>;
        return (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setProofTransactionId(txn.id);
            }}
          >
            View Proof
          </Button>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setDetailId(row.original.id);
          }}
        >
          Manage Transaction
        </Button>
      ),
    },
  ];

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned.</p>;
  }

  return (
    <div className="app-section app-section-gap overflow-y-auto p-6">
      <div>
        <h1 className="app-title font-bold">Receipts</h1>
        <p className="text-sm text-muted-foreground">Look up a past sale from this branch and reprint its receipt.</p>
      </div>

      <DataTable
        columns={columns}
        data={data?.transactions ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(row) => setSelectedId(row.id)}
        emptyState={<EmptyState icon={ReceiptIcon} title="No receipts yet" description="Completed sales at this branch will appear here." />}
      />

      <ReceiptModal transaction={selectedTransaction ?? null} onClose={() => setSelectedId(null)} />
      <ViewPaymentProofDialog transactionId={proofTransactionId} onOpenChange={(o) => !o && setProofTransactionId(null)} />
      <ViewTransactionDetailDialog
        transaction={detailTransaction ?? null}
        onClose={() => setDetailId(null)}
        branchName={branch?.name ?? null}
        cashierName={cashier ? `${cashier.first_name} ${cashier.last_name}` : (detailTransaction?.cashier_id ?? '')}
        attendanceRecords={attendanceData?.records ?? []}
      />
    </div>
  );
}
