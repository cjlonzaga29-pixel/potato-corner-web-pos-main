'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { cn, formatCurrency, formatDate } from '@/lib/utils';

export interface ExpenseReceiptProofData {
  id: string;
  receiptUrl: string;
  branchName: string;
  categoryLabel: string;
  vendorName: string | null;
  amount: number;
  incurredAt: string;
  createdByName: string;
}

interface ViewExpenseReceiptDialogProps {
  expense: ExpenseReceiptProofData | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}

/**
 * Read-only proof viewer for the Finance > Expenses "View Receipt" action —
 * same modal shell as ViewDiscountProofDialog/ViewInventoryMovementProofDialog,
 * but unlike those, expenses.service.ts already signs receipt_url eagerly on
 * every list row, so there's no separate fetch-on-open query here — this just
 * displays the URL already on the row. Retry re-runs the caller's list query
 * to mint a fresh signed URL if the cached one has expired.
 */
export function ViewExpenseReceiptDialog({ expense, onOpenChange, onRetry }: ViewExpenseReceiptDialogProps) {
  const open = expense !== null;
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  useEffect(() => {
    if (open) setStatus('loading');
  }, [open, expense?.receiptUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Expense Receipt</DialogTitle>
        </DialogHeader>
        {expense && (
          <div className="space-y-3">
            <div className="relative">
              {status === 'loading' && (
                <div className="flex justify-center py-8">
                  <LoadingSpinner />
                </div>
              )}
              {status === 'error' && (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <p className="text-sm text-destructive">Unable to load receipt. Please try again.</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setStatus('loading');
                      onRetry();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase Storage URL, not an optimizable local asset */}
              <img
                key={expense.receiptUrl}
                src={expense.receiptUrl}
                alt={`Expense receipt for ${expense.branchName}`}
                className={cn('mx-auto max-h-[70vh] w-full rounded-md border object-contain', status !== 'loaded' && 'hidden')}
                onLoad={() => setStatus('loaded')}
                onError={() => setStatus('error')}
              />
            </div>
            <div className="space-y-0.5 border-t pt-2 text-sm">
              <p className="font-medium">{expense.branchName}</p>
              <p className="text-muted-foreground">
                {expense.categoryLabel}
                {expense.vendorName ? ` · ${expense.vendorName}` : ''} · {formatCurrency(expense.amount)}
              </p>
              <p className="text-xs text-muted-foreground">
                Recorded by {expense.createdByName} · {formatDate(expense.incurredAt)}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
