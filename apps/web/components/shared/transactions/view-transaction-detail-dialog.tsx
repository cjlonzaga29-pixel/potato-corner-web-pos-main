'use client';

import { useState } from 'react';
import type { AttendanceResponse, TransactionResponse } from '@potato-corner/shared';
import { ROLES } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { StatusBadge } from '@/components/shared/status-badge';
import { useAuthStore } from '@/stores/auth.store';
import { useVoidTransaction } from '@/hooks/queries/use-transactions';
import { formatCurrency } from '@/lib/utils';

const MIN_VOID_REASON_LENGTH = 10;
const VOID_ALLOWED_ROLES = [ROLES.SUPER_ADMIN, ROLES.SUPERVISOR, ROLES.BRANCH] as const;

interface ViewTransactionDetailDialogProps {
  transaction: TransactionResponse | null;
  onClose: () => void;
  branchName: string | null;
  cashierName: string;
  /** Same-branch attendance rows already loaded by the caller — used only to find the clock-in session covering this sale's timestamp. Transaction rows don't store an attendance FK, so this is a best-effort match, not an authoritative link. */
  attendanceRecords: AttendanceResponse[];
}

const PAYMENT_METHOD_LABEL: Record<TransactionResponse['payment_method'], string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  other: 'Other',
};

function formatManila(date: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(date));
}

function findCoveringSession(transaction: TransactionResponse, attendanceRecords: AttendanceResponse[]): AttendanceResponse | null {
  const soldAt = new Date(transaction.created_at).getTime();
  return (
    attendanceRecords.find((record) => {
      if (record.employee_id !== transaction.cashier_id) return false;
      const clockIn = new Date(record.clock_in_server_time).getTime();
      const clockOut = record.clock_out_server_time ? new Date(record.clock_out_server_time).getTime() : Infinity;
      return soldAt >= clockIn && soldAt <= clockOut;
    }) ?? null
  );
}

/** Full transaction detail (Reports §11) — branch/cashier/session/items/amounts/payment/status/inventory deduction outcome for one sale. */
export function ViewTransactionDetailDialog({ transaction, onClose, branchName, cashierName, attendanceRecords }: ViewTransactionDetailDialogProps) {
  const session = transaction ? findCoveringSession(transaction, attendanceRecords) : null;
  const role = useAuthStore((state) => state.user?.role);
  const canVoid = role !== undefined && (VOID_ALLOWED_ROLES as readonly string[]).includes(role);

  const [isVoidConfirmOpen, setIsVoidConfirmOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const voidTransaction = useVoidTransaction(transaction?.id ?? '');

  function resetVoidState() {
    setIsVoidConfirmOpen(false);
    setVoidReason('');
  }

  function handleVoidSubmit() {
    if (voidReason.trim().length < MIN_VOID_REASON_LENGTH) return;
    voidTransaction.mutate(
      { void_reason: voidReason },
      {
        onSuccess: () => {
          resetVoidState();
          onClose();
        },
      },
    );
  }

  const canSubmitVoid = voidReason.trim().length >= MIN_VOID_REASON_LENGTH && !voidTransaction.isPending;

  return (
    <Dialog open={transaction !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transaction {transaction?.receipt_number}</DialogTitle>
        </DialogHeader>
        {transaction && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span className="text-muted-foreground">Branch</span>
              <span>{branchName ?? '—'}</span>
              <span className="text-muted-foreground">Cashier</span>
              <span>{cashierName}</span>
              <span className="text-muted-foreground">Attendance session</span>
              <span>
                {session
                  ? `${formatManila(session.clock_in_server_time)} – ${session.clock_out_server_time ? formatManila(session.clock_out_server_time) : 'ongoing'}`
                  : 'Not available'}
              </span>
              <span className="text-muted-foreground">Date/Time (Manila)</span>
              <span>{formatManila(transaction.created_at)}</span>
              <span className="text-muted-foreground">Payment Method</span>
              <span>{PAYMENT_METHOD_LABEL[transaction.payment_method]}</span>
              <span className="text-muted-foreground">Status</span>
              <span>
                <StatusBadge status={transaction.status} type="transaction" />
              </span>
              <span className="text-muted-foreground">Inventory Deduction</span>
              <span>
                <Badge variant={transaction.inventory_deduction_status === 'failed' ? 'critical' : 'outline'}>
                  {transaction.inventory_deduction_status}
                </Badge>
              </span>
            </div>

            <div className="space-y-1 border-t pt-2">
              <p className="font-medium">Items Sold</p>
              {(transaction.items ?? []).map((item) => (
                <div key={item.id} className="flex justify-between gap-2">
                  <span>
                    {item.quantity}x {item.product_name}
                    {item.flavor_name ? ` (${item.flavor_name})` : ''} — {item.variant_name}
                  </span>
                  <span className="tabular-nums">{formatCurrency(item.line_total)}</span>
                </div>
              ))}
            </div>

            <div className="space-y-1 border-t pt-2">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatCurrency(transaction.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>VAT</span>
                <span className="tabular-nums">{formatCurrency(transaction.vat_amount)}</span>
              </div>
              <div className="flex justify-between">
                <span>Discount{transaction.discount_type ? ` (${transaction.discount_type})` : ''}</span>
                <span className="tabular-nums">-{formatCurrency(transaction.discount_amount)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatCurrency(transaction.total_amount)}</span>
              </div>
            </div>

            {canVoid && transaction.status === 'completed' && (
              <DialogFooter className="border-t pt-3">
                <Button variant="danger" onClick={() => setIsVoidConfirmOpen(true)}>
                  Void Transaction
                </Button>
              </DialogFooter>
            )}
          </div>
        )}
      </DialogContent>

      <AlertDialog open={isVoidConfirmOpen} onOpenChange={voidTransaction.isPending ? undefined : (open) => !open && resetVoidState()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void Transaction</AlertDialogTitle>
            <AlertDialogDescription>
              This action will permanently void this completed transaction. Inventory will be restored automatically. Sales
              reports will automatically exclude this transaction.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <Label htmlFor="void-reason">Reason (required, min {MIN_VOID_REASON_LENGTH} characters)</Label>
            <Textarea
              id="void-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              disabled={voidTransaction.isPending}
              rows={4}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={resetVoidState} disabled={voidTransaction.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleVoidSubmit();
              }}
              disabled={!canSubmitVoid}
              className={buttonVariants({ variant: 'danger' })}
            >
              {voidTransaction.isPending ? <LoadingSpinner size="sm" className="text-current" /> : 'Void Transaction'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
