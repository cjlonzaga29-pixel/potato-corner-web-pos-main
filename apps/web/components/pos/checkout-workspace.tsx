'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { Receipt, ShoppingCart } from 'lucide-react';
import type { ImageProofType } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { CartLineItem, type CartLine } from '@/components/pos/cart-line-item';
import { PaymentFooter, type DiscountChoice } from '@/components/pos/payment-footer';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface OrderReviewPanelProps {
  cartLines: CartLine[];
  onEditLine: (index: number) => void;
  onRemoveLine: (index: number) => void;
  onQuantityChange: (index: number, quantity: number) => void;
  subtotal: number;
  vatAmount: number;
  discountAmount: number;
  totalAmount: number;
  className?: string;
}

/**
 * Task 209.25 — the order side of the Checkout Workspace. Reuses the exact
 * same CartLineItem the permanent side cart renders (same edit/remove/qty
 * handlers, same memoized `cartLines` the terminal page already derives) and
 * the Subtotal/Discount/VAT/TOTAL breakdown that used to live at the top of
 * PaymentFooter — moved here verbatim (same canonical values, no
 * recalculation) per the owner's Order Review pane spec. Owns its own
 * scroll region so a long cart never pushes the totals or the sibling
 * Payment pane out of place.
 */
export function OrderReviewPanel({
  cartLines,
  onEditLine,
  onRemoveLine,
  onQuantityChange,
  subtotal,
  vatAmount,
  discountAmount,
  totalAmount,
  className,
}: OrderReviewPanelProps) {
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`}>
      <div className="app-pos-section-padding min-h-0 flex-1 overflow-y-auto">
        {cartLines.length === 0 ? (
          <EmptyState compact icon={ShoppingCart} title="Cart is empty" description="Add products before checking out." />
        ) : (
          <div className="space-y-3">
            {cartLines.map((line, i) => (
              <CartLineItem
                key={line.index}
                line={line}
                showDivider={i > 0}
                onEdit={onEditLine}
                onRemove={onRemoveLine}
                onQuantityChange={onQuantityChange}
              />
            ))}
          </div>
        )}
      </div>
      <div className="app-pos-footer shrink-0 border-t">
        <div className="text-sm" aria-label="Order totals">
          <div className="app-pos-total-row flex items-center justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatPeso(subtotal)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="app-pos-total-row flex items-center justify-between font-medium text-destructive">
              <span>Discount</span>
              <span className="tabular-nums">-{formatPeso(discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>VAT (12%)</span>
            <span className="tabular-nums">{formatPeso(vatAmount)}</span>
          </div>
          <Separator className="my-1.5 lg:my-1" />
          <div className="app-pos-total-row flex items-center justify-between rounded-lg bg-primary/5 px-2.5">
            <span className="text-sm font-semibold">Total</span>
            <span className="flex items-center gap-1.5 text-xl font-bold tabular-nums text-primary">
              <Receipt className="h-4 w-4 text-primary/70" aria-hidden="true" />
              {formatPeso(totalAmount)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Task 209.25 — the payment side of the Checkout Workspace. A thin scroll
 * wrapper around the existing PaymentFooter (Void/Refund entry point,
 * payment method, discount, proof, Cash Tendered/Change, and the final
 * Charge/Confirm control) — no payment/discount/proof/charge logic
 * duplicated, only relocated.
 */
type PaymentFooterProps = ComponentProps<typeof PaymentFooter>;

export function PaymentPanel(props: PaymentFooterProps & { className?: string }) {
  const { className, ...paymentFooterProps } = props;
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto ${className ?? ''}`}>
      <PaymentFooter {...paymentFooterProps} />
    </div>
  );
}

// Task 209.29 — whether the stepped/mobile checkout needs a dedicated Proof
// step at all, purely a function of the same discountType/paymentMethod
// PaymentFooter itself already branches on (no new validation rule). When
// neither a discount ID proof nor a payment proof applies (e.g. no discount,
// paying cash), the Payment step's own CTA becomes Confirm directly — an
// empty "Proof" step with nothing to attach would just be an extra tap.
function needsProofStep(discountType: PaymentFooterProps['discountType'], paymentMethod: PaymentFooterProps['paymentMethod']): boolean {
  return discountType === 'pwd' || discountType === 'senior_citizen' || paymentMethod !== 'cash';
}

interface CheckoutWorkspaceProps extends PaymentFooterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Task 209.25 — 'two-pane' when the terminal page's own
   * shouldShowInlineCart/useHasRoomForInlineCart already decided there's
   * room for a persistent side panel (desktop/laptop, and a docked touch
   * tablet with >=1024px width); 'stepped' otherwise (phones and narrow
   * tablet portrait — the same viewports that already get the mobile View
   * Cart Sheet instead of the inline cart panel). Reuses that existing
   * classification rather than inventing a second, competing breakpoint.
   */
  layout: 'two-pane' | 'stepped';
  cartLines: CartLine[];
  onEditLine: (index: number) => void;
  onRemoveLine: (index: number) => void;
  onQuantityChange: (index: number, quantity: number) => void;
  subtotal: number;
  vatAmount: number;
  discountAmount: number;
}

/**
 * Task 209.25 — Responsive Checkout Workspace. Consumes the terminal page's
 * existing cart/payment/discount/proof state and totals unchanged (single
 * source of truth stays in terminal/page.tsx — this component owns no
 * cart/payment state of its own, only which of the two panes is visible on
 * a stepped/mobile layout). Opening/closing never creates a transaction,
 * clears the cart, or resets quantities — the only control that ever
 * invokes the transaction mutation is PaymentFooter's Charge/Confirm button,
 * forwarded here unchanged as `onCharge`.
 */
export function CheckoutWorkspace({
  open,
  onOpenChange,
  layout,
  cartLines,
  onEditLine,
  onRemoveLine,
  onQuantityChange,
  subtotal,
  vatAmount,
  discountAmount,
  ...paymentFooterProps
}: CheckoutWorkspaceProps) {
  const { totalAmount, isChargePending, discountType, paymentMethod } = paymentFooterProps;
  const [step, setStep] = useState<'review' | 'payment' | 'proof'>('review');
  const requiresProofStep = needsProofStep(discountType, paymentMethod);

  // Task 209.25 — every reopen starts back on Order Review, same as a fresh
  // checkout would; this never touches cart/payment/discount/proof state,
  // only which pane is visible on a stepped layout.
  useEffect(() => {
    if (open) setStep('review');
  }, [open]);

  const reviewPanel = (
    <OrderReviewPanel
      cartLines={cartLines}
      onEditLine={onEditLine}
      onRemoveLine={onRemoveLine}
      onQuantityChange={onQuantityChange}
      subtotal={subtotal}
      vatAmount={vatAmount}
      discountAmount={discountAmount}
      totalAmount={totalAmount}
    />
  );
  const paymentPanel = <PaymentPanel {...paymentFooterProps} />;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Task 209.25 (Part L) — closing never cancels an in-flight charge;
        // the mutation and its cart-preservation/duplicate-submit guards
        // (terminal/page.tsx's handleCharge) keep running exactly as if the
        // workspace had stayed open.
        if (!next && isChargePending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        // `.app-dialog-padding` (base DialogContent styling) is a custom
        // class, not a Tailwind utility twMerge recognizes as conflicting
        // with `p-0` — same reasoning as PaymentFooter's proof-card padding
        // (see payment-footer.tsx). An inline style is the only override
        // that reliably wins regardless of CSS source order; the workspace
        // manages its own section padding per-region instead (header/panes/
        // footer each carry `.app-pos-section-padding`/`.app-pos-footer`).
        // Task 209.29 — the base DialogContent className (dialog.tsx) always
        // carries `overflow-y-auto` for its own default max-h-[calc(100vh-2rem)]
        // sizing; neither layout variant below overrides it, so every
        // checkout dialog was quietly getting a SECOND, outer scroll
        // container around the workspace's own intentional scroll regions
        // (OrderReviewPanel's list, PaymentPanel/PaymentFooter's proof-step
        // area). On real touch devices this nested-scroll setup is exactly
        // what produced "can't reliably scroll" / "bottom action not
        // reachable" — the outer auto-scroll region and the inner one fight
        // over the same touch gesture. `overflow-hidden` here (twMerge
        // removes the base `overflow-y-auto` for it — same `overflow`/
        // `overflow-y` conflict group tailwind-merge already resolves
        // elsewhere in this file) makes the workspace's inner regions the
        // only things that ever scroll, in both layouts.
        style={{ padding: 0 }}
        className={
          layout === 'two-pane'
            ? 'flex h-[min(88dvh,800px)] max-h-[min(88dvh,800px)] w-[min(96vw,1200px)] max-w-[min(96vw,1200px)] flex-col gap-0 overflow-hidden'
            : 'flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none sm:h-[90dvh] sm:max-h-[90dvh] sm:w-[95vw] sm:max-w-[95vw] sm:rounded-xl'
        }
      >
        <DialogHeader className="app-pos-section-padding shrink-0 border-b text-left">
          <DialogTitle>Checkout</DialogTitle>
          <DialogDescription>Review the order, then complete payment. Nothing is charged until you confirm.</DialogDescription>
        </DialogHeader>

        {layout === 'two-pane' ? (
          <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
            <div className="app-checkout-review-pane flex min-h-0 flex-col border-r">
              <h3 className="app-pos-section-padding shrink-0 pb-0 text-sm font-semibold">Order Review</h3>
              {reviewPanel}
            </div>
            <div className="app-checkout-payment-pane flex min-h-0 flex-col">
              <h3 className="app-pos-section-padding shrink-0 pb-0 text-sm font-semibold">Payment</h3>
              {paymentPanel}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {step === 'review' && (
              <>
                {reviewPanel}
                <div className="app-pos-footer shrink-0 border-t">
                  <Button variant="pos" className="w-full" onClick={() => setStep('payment')} disabled={cartLines.length === 0}>
                    Continue to Payment
                  </Button>
                </div>
              </>
            )}
            {step === 'payment' && (
              <>
                <div className="app-pos-section-padding shrink-0 border-b py-2">
                  <Button variant="ghost" size="sm" className="app-control -ml-2" onClick={() => setStep('review')}>
                    ← Back
                  </Button>
                </div>
                <PaymentPanel {...paymentFooterProps} section="fields" />
                {/* Task 209.29 (Part D/N) — a structurally separate,
                    shrink-0 action bar below the scrollable fields, same
                    pattern as OrderReviewPanel's totals footer. When no
                    discount ID or payment proof applies, this step is
                    already the last one, so it renders the real Confirm
                    control (section="confirm": validation alerts + Charge)
                    instead of an extra "Continue" tap into an empty Proof
                    step. PaymentFooter's own root already carries
                    `.app-pos-footer` (padding+gap), so the "Continue"
                    button — the one branch with no PaymentFooter inside —
                    is the only one that needs it added on the wrapper
                    itself; adding it to both would double the padding. */}
                {requiresProofStep ? (
                  <div className="app-pos-footer shrink-0 border-t">
                    <Button variant="pos" className="w-full" onClick={() => setStep('proof')}>
                      Continue
                    </Button>
                  </div>
                ) : (
                  <div className="shrink-0 border-t">
                    <PaymentFooter {...paymentFooterProps} section="confirm" />
                  </div>
                )}
              </>
            )}
            {step === 'proof' && (
              <>
                <div className="app-pos-section-padding shrink-0 border-b py-2">
                  <Button variant="ghost" size="sm" className="app-control -ml-2" onClick={() => setStep('payment')}>
                    ← Back
                  </Button>
                </div>
                <PaymentPanel {...paymentFooterProps} section="proof" />
                <div className="shrink-0 border-t">
                  <PaymentFooter {...paymentFooterProps} section="confirm" />
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export type { DiscountChoice, ImageProofType };
