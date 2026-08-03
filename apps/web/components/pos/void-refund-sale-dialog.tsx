'use client';

import { useState } from 'react';
import type { TransactionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ViewTransactionDetailDialog } from '@/components/shared/transactions/view-transaction-detail-dialog';
import { useTransaction, useTransactions } from '@/hooks/queries/use-transactions';
import { useAttendanceByEmployee } from '@/hooks/queries/use-attendance';
import { useBranch } from '@/hooks/queries/use-branches';
import { useEmployee } from '@/hooks/queries/use-employees';
import { formatDateTime } from '@/lib/utils';

interface VoidRefundSaleDialogProps {
  branchId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PAYMENT_METHOD_LABEL: Record<TransactionResponse['payment_method'], string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  other: 'Other',
};

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

function CashierName({ employeeId }: { employeeId: string }) {
  const { data } = useEmployee(employeeId);
  if (!data) return null;
  return (
    <>
      {data.first_name} {data.last_name}
    </>
  );
}

/**
 * Faster POS Terminal entry point onto the existing Void/Refund workflow —
 * lists this branch's recent transactions and hands the clicked row's id to
 * the same ViewTransactionDetailDialog the Receipts page already uses. Void
 * and Refund logic, role gating, and reason validation all live there; this
 * dialog only surfaces which transaction to manage.
 */
export function VoidRefundSaleDialog({ branchId, open, onOpenChange }: VoidRefundSaleDialogProps) {
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useTransactions({
    branch_id: open ? branchId : undefined,
    page: 1,
    limit: 10,
  });
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
  const { data: attendanceData } = useAttendanceByEmployee(detailTransaction?.cashier_id, {
    ...attendanceWindow,
    limit: 100,
  });

  const transactions = data?.transactions ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Void or Refund Sale</DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="flex justify-center py-10">
              <LoadingSpinner size="lg" />
            </div>
          ) : isError ? (
            <ErrorState title="Failed to load recent sales" retry={() => void refetch()} />
          ) : transactions.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No completed sales available to void or refund.</p>
          ) : (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {transactions.map((txn) => (
                <div key={txn.id} className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate font-medium">{txn.receipt_number}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatDateTime(txn.created_at)} · <CashierName employeeId={txn.cashier_id} /> · {PAYMENT_METHOD_LABEL[txn.payment_method]}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-semibold tabular-nums">{formatPeso(txn.total_amount)}</span>
                    <StatusBadge status={txn.status} type="transaction" />
                    <Button type="button" variant="outline" size="sm" onClick={() => setDetailId(txn.id)}>
                      Manage
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ViewTransactionDetailDialog
        transaction={detailTransaction ?? null}
        onClose={() => setDetailId(null)}
        branchName={branch?.name ?? null}
        cashierName={cashier ? `${cashier.first_name} ${cashier.last_name}` : (detailTransaction?.cashier_id ?? '')}
        attendanceRecords={attendanceData?.records ?? []}
      />
    </>
  );
}
