'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Printer } from 'lucide-react';
import type { TransactionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useMarkReceiptPrinted } from '@/hooks/queries/use-transactions';
import { useEmployee } from '@/hooks/queries/use-employees';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

const PAYMENT_METHOD_LABEL: Record<TransactionResponse['payment_method'], string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  other: 'Other',
};

interface ReceiptModalProps {
  transaction: TransactionResponse | null;
  onClose: () => void;
}

/**
 * Shown after a successful charge. print styles live in globals.css under
 * @media print, scoped to #receipt-print-area.
 *
 * Task 196 (visual redesign) — clear success state (icon + "Sale
 * completed"), receipt number/total/payment method/timestamp summary up
 * top, "Print Receipt" that becomes "Print Again" once printed this
 * session, and "New Sale" as the primary closing action. window.print() and
 * the receipt-printed mutation are exactly the same call as before — this
 * never creates another transaction and a receipt-printed request failing
 * never hides the already-successful sale (isPrinted is local UI state, not
 * gated on markPrinted succeeding).
 */
export function ReceiptModal({ transaction, onClose }: ReceiptModalProps) {
  const markPrinted = useMarkReceiptPrinted(transaction?.id ?? '');
  // The receipt's actual cashier, not the viewer — a supervisor/admin
  // opening someone else's receipt must never see their own name here.
  const { data: cashier } = useEmployee(transaction?.cashier_id);
  const [hasPrinted, setHasPrinted] = useState(false);

  // A fresh transaction (new sale) always starts back at the un-printed state.
  useEffect(() => {
    setHasPrinted(false);
  }, [transaction?.id]);

  if (!transaction) return null;

  function handlePrint() {
    window.print();
    setHasPrinted(true);
    if (transaction) void markPrinted.mutateAsync();
  }

  return (
    <Dialog open={Boolean(transaction)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex flex-col items-center gap-2 pb-1 text-center print:hidden">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
            </div>
            <DialogTitle className="text-center">Sale completed</DialogTitle>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>Receipt No. {transaction.receipt_number}</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(transaction.created_at).toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xl font-bold tabular-nums text-foreground">{formatPeso(transaction.total_amount)}</span>
              <Badge variant="active">{PAYMENT_METHOD_LABEL[transaction.payment_method]}</Badge>
            </div>
          </div>
        </DialogHeader>

        <div id="receipt-print-area" className="space-y-3 text-sm">
          <div className="text-center">
            <p className="font-semibold">Potato Corner</p>
            <p className="text-xs text-muted-foreground">{new Date(transaction.created_at).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Receipt No. {transaction.receipt_number}</p>
            <p className="text-xs text-muted-foreground">Cashier: {cashier ? `${cashier.first_name} ${cashier.last_name}`.trim() : ''}</p>
          </div>

          <div className="space-y-1 border-y py-2">
            {transaction.items?.map((item) => (
              <div key={item.id}>
                <div className="flex justify-between gap-2">
                  <span>
                    {item.quantity}x {item.product_name}
                    {item.flavor_name ? ` (${item.flavor_name})` : ''} — {item.variant_name}
                  </span>
                  <span className="tabular-nums">{formatPeso(item.line_total)}</span>
                </div>
                {item.selected_options.map((option) => (
                  <div key={option.option_id} className="flex justify-between gap-2 pl-4 text-xs text-muted-foreground">
                    <span>+ {option.option_name}</span>
                    {option.price_adjustment !== 0 && <span className="tabular-nums">{formatPeso(option.price_adjustment)}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatPeso(transaction.subtotal)}</span>
            </div>
            {transaction.discount_amount > 0 && (
              <div className="flex justify-between">
                <span>Discount {transaction.discount_type ? `(${transaction.discount_type})` : ''}</span>
                <span className="tabular-nums">-{formatPeso(transaction.discount_amount)}</span>
              </div>
            )}
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>VAT (12%)</span>
              <span className="tabular-nums">{formatPeso(transaction.vat_amount)}</span>
            </div>
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatPeso(transaction.total_amount)}</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Payment Method</span>
              <Badge variant="outline" className="font-medium">
                {PAYMENT_METHOD_LABEL[transaction.payment_method]}
              </Badge>
            </div>
            {transaction.payment_method === 'cash' ? (
              <>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Cash Tendered</span>
                  <span className="tabular-nums">{formatPeso(transaction.cash_tendered ?? 0)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Change</span>
                  <span className="tabular-nums">{formatPeso(transaction.change_given ?? 0)}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{transaction.payment_method === 'other' ? 'Reference' : `${transaction.payment_method === 'gcash' ? 'GCash' : 'Maya'} Ref.`}</span>
                <span>{transaction.payment_reference}</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex-row gap-2 print:hidden sm:justify-normal">
          <Button variant="outline" className="touch-target flex-1" onClick={handlePrint} disabled={markPrinted.isPending}>
            {markPrinted.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {hasPrinted ? 'Print Again' : 'Print Receipt'}
          </Button>
          <Button className="touch-target flex-1" onClick={onClose}>
            New Sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
