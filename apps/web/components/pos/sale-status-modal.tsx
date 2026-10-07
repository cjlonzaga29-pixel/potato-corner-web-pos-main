'use client';

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { TransactionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

const PAYMENT_METHOD_LABEL: Record<TransactionResponse['payment_method'], string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  other: 'Other',
};

/**
 * POS-PERF-P15 — the submitted-order snapshot shown the instant Checkout is
 * clicked, before the server has confirmed anything. Deliberately has no
 * receipt/transaction number field: the real BIR receipt number is only
 * ever allocated server-side once the sale actually persists (see
 * transactions.service.ts generateReceiptNumber) — this type structurally
 * cannot invent one.
 */
export interface SaleSnapshotItem {
  id: string;
  productName: string;
  variantName: string;
  flavorName: string | null;
  quantity: number;
  lineTotal: number;
  optionSelections: { option_id: string; option_name: string; price_adjustment: number }[];
}

export interface SaleSnapshot {
  items: SaleSnapshotItem[];
  subtotal: number;
  discountAmount: number;
  discountType: string | null;
  vatAmount: number;
  totalAmount: number;
  paymentMethod: TransactionResponse['payment_method'];
  cashTendered: number | null;
  changeGiven: number | null;
}

export type SalePopupPhase = 'saving' | 'success' | 'error';

interface SaleStatusModalProps {
  phase: SalePopupPhase;
  /** The submitted order, known client-side the instant Checkout was clicked. Populated for every phase this component renders. */
  snapshot: SaleSnapshot;
  /** Populated only when phase is 'error'. */
  errorMessage: string | null;
  /** Resubmits the exact same cart under the same idempotency key — never creates a second sale even if the original request actually succeeded server-side. */
  onRetry: () => void;
  /** Error phase only: dismiss back to the cart/checkout review, retaining every submitted item exactly as entered. */
  onEditCart: () => void;
  /** Success phase only: opens the full receipt (ReceiptModal) on top of this confirmation. */
  onViewReceipt: () => void;
  /**
   * POS-PERF-P19 — available on EVERY phase, not just 'success'. On
   * 'saving' this detaches the still-in-flight order (see
   * lib/detached-sales.ts) rather than waiting for it: its eventual
   * success/failure keeps updating independently in the Pending Sales
   * panel, and this modal closes immediately so the cashier can open a
   * fresh cart right away. On 'success'/'error' it behaves as before
   * (clears/retains the cart as appropriate).
   */
  onNewSale: () => void;
}

/**
 * POS-PERF-P15 — opens the instant Checkout is clicked (phase 'saving',
 * nothing but the client-known snapshot — no server round trip has even
 * started yet), then transitions in place to 'success' (a compact
 * confirmation with View Receipt / New Sale — the full receipt is
 * ReceiptModal, opened separately via onViewReceipt) or 'error' (Retry /
 * Edit Cart, cart retained). No close (X) on any phase — there is always an
 * explicit action, never an incidental dismiss that could leave the cashier
 * unsure whether the sale happened.
 *
 * POS-PERF-P19 — 'saving' no longer blocks the cashier for the full
 * round-trip: New Sale is enabled on every phase, including 'saving'. On
 * 'saving' it detaches this order (lib/detached-sales.ts) rather than
 * cancelling or waiting on it — the parent terminal page routes the
 * eventual success/failure to that detached record instead of this modal,
 * which is already closed by then.
 */
export function SaleStatusModal({ phase, snapshot, errorMessage, onRetry, onEditCart, onViewReceipt, onNewSale }: SaleStatusModalProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // No incidental dismiss while a request is actually in flight — see
        // the component doc comment. Escape/outside-click on 'error' or
        // 'success' maps to the same explicit action its own button would.
        if (phase === 'error') onEditCart();
        else if (phase === 'success') onNewSale();
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <div className="flex flex-col items-center gap-2 pb-1 text-center">
            {phase === 'saving' && (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
                </div>
                <DialogTitle className="text-center">Saving sale…</DialogTitle>
                <DialogDescription className="text-center">
                  Saving — pending confirmation. You can start the next sale now; this one keeps saving in the background.
                </DialogDescription>
              </>
            )}
            {phase === 'error' && (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                  <AlertTriangle className="h-7 w-7" aria-hidden="true" />
                </div>
                <DialogTitle className="text-center">Couldn&apos;t save sale</DialogTitle>
                <DialogDescription className="text-center">
                  {errorMessage ?? 'Something went wrong. Your cart is still here — retry or edit it below.'}
                </DialogDescription>
              </>
            )}
            {phase === 'success' && (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
                  <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
                </div>
                <DialogTitle className="text-center">Sale completed</DialogTitle>
              </>
            )}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xl font-bold tabular-nums text-foreground">{formatPeso(snapshot.totalAmount)}</span>
              <Badge variant={phase === 'success' ? 'active' : 'outline'}>{PAYMENT_METHOD_LABEL[snapshot.paymentMethod]}</Badge>
              {phase === 'saving' && <Badge variant="outline">Pending confirmation</Badge>}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-1 border-y py-2 text-sm">
          {snapshot.items.map((item) => (
            <div key={item.id} className="flex justify-between gap-2">
              <span>
                {item.quantity}x {item.productName}
                {item.flavorName ? ` (${item.flavorName})` : ''} — {item.variantName}
              </span>
              <span className="tabular-nums">{formatPeso(item.lineTotal)}</span>
            </div>
          ))}
        </div>

        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatPeso(snapshot.subtotal)}</span>
          </div>
          {snapshot.discountAmount > 0 && (
            <div className="flex justify-between">
              <span>Discount</span>
              <span className="tabular-nums">-{formatPeso(snapshot.discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-1 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatPeso(snapshot.totalAmount)}</span>
          </div>
          {snapshot.paymentMethod === 'cash' && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Change</span>
              <span className="tabular-nums">{formatPeso(snapshot.changeGiven ?? 0)}</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-normal">
          {phase === 'saving' && (
            <>
              <Button className="touch-target flex-1" disabled>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Saving…
              </Button>
              {/* POS-PERF-P19 — enabled immediately, unlike the disabled
                  "Saving…" indicator beside it. Clicking this does not wait
                  on or cancel the in-flight request — see onNewSale's doc
                  comment on SaleStatusModalProps. */}
              <Button variant="outline" className="touch-target flex-1" onClick={onNewSale}>
                New Sale
              </Button>
            </>
          )}
          {phase === 'error' && (
            <>
              <Button variant="outline" className="touch-target flex-1" onClick={onEditCart}>
                Edit Cart
              </Button>
              <Button className="touch-target flex-1" onClick={onRetry}>
                Retry
              </Button>
            </>
          )}
          {phase === 'success' && (
            <>
              <Button variant="outline" className="touch-target flex-1" onClick={onViewReceipt}>
                View Receipt
              </Button>
              <Button className="touch-target flex-1" onClick={onNewSale}>
                New Sale
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
