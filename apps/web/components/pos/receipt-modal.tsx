'use client';

import type { TransactionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useMarkReceiptPrinted } from '@/hooks/queries/use-transactions';
import { useEmployee } from '@/hooks/queries/use-employees';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface ReceiptModalProps {
  transaction: TransactionResponse | null;
  onClose: () => void;
}

/** Shown after a successful charge. print styles live in globals.css under @media print, scoped to #receipt-print-area. */
export function ReceiptModal({ transaction, onClose }: ReceiptModalProps) {
  const markPrinted = useMarkReceiptPrinted(transaction?.id ?? '');
  // The receipt's actual cashier, not the viewer — a supervisor/admin
  // opening someone else's receipt must never see their own name here.
  const { data: cashier } = useEmployee(transaction?.cashier_id);

  if (!transaction) return null;

  function handlePrint() {
    window.print();
    if (transaction) void markPrinted.mutateAsync();
  }

  return (
    <Dialog open={Boolean(transaction)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Receipt</DialogTitle>
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

        <DialogFooter>
          <Button variant="outline" onClick={handlePrint}>
            Print
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
