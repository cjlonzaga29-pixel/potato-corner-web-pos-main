'use client';

import { memo } from 'react';
import { CheckCircle2, Eye, Loader2, X } from 'lucide-react';
import type { ImageProofType } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ImageUpload } from '@/components/shared/forms/image-upload';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

/**
 * Task 209.20 — the collapsed "attached" row a captured discount/payment
 * proof renders as, instead of ImageUpload's own (now-unmounted) full-size
 * preview staying visible for the rest of checkout. `previewUrl` is the
 * terminal page's locally-held object URL for the just-captured file (lost
 * on refresh, same as ImageUpload's own preview always was) — when present,
 * "View" opens it full-size in a Dialog; when absent (nothing to show), the
 * button is omitted rather than opening an empty dialog. `onClear` backs
 * both "Replace" and "Remove": both return to the same pre-capture
 * ImageUpload state, since a discount/payment proof has no distinct "empty
 * but was once removed" state to preserve — the API contract is unchanged.
 */
function ProofSummary({ label, previewUrl, onClear }: { label: string; previewUrl: string | null; onClear: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-success bg-success/10 px-3 py-2 text-xs text-success">
      <span className="flex min-w-0 items-center gap-1.5">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {previewUrl && (
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs underline">
                <Eye className="mr-1 h-3 w-3" aria-hidden="true" />
                View
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{label}</DialogTitle>
              </DialogHeader>
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset */}
              <img src={previewUrl} alt={label} className="w-full rounded-md" />
            </DialogContent>
          </Dialog>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs underline" onClick={onClear}>
          Replace
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs underline" onClick={onClear} aria-label={`Remove ${label.toLowerCase()}`}>
          <X className="h-3 w-3" aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

export type DiscountChoice = 'none' | 'pwd' | 'senior_citizen' | 'employee' | 'promotional';

export const DISCOUNT_LABELS: Record<DiscountChoice, string> = {
  none: 'No discount',
  pwd: 'PWD (20%)',
  senior_citizen: 'Senior Citizen (20%)',
  employee: 'Employee (20%)',
  promotional: 'Promotional',
};

interface PaymentFooterProps {
  totalAmount: number;
  discountType: DiscountChoice;
  onDiscountTypeChange: (value: DiscountChoice) => void;
  discountIdReference: string;
  onDiscountIdReferenceChange: (value: string) => void;
  discountProofKey: string | null;
  discountProofPreviewUrl: string | null;
  onDiscountProofSelected: (file: File, type: ImageProofType) => Promise<void>;
  onClearDiscountProof: () => void;
  promoAmount: string;
  onPromoAmountChange: (value: string) => void;
  paymentMethod: 'cash' | 'gcash' | 'maya' | 'other';
  onPaymentMethodChange: (value: 'cash' | 'gcash' | 'maya' | 'other') => void;
  isOnline: boolean;
  cashTendered: string;
  onCashTenderedChange: (value: string) => void;
  change: number;
  paymentProofKey: string | null;
  paymentProofPreviewUrl: string | null;
  onProofSelected: (file: File, type: ImageProofType) => Promise<void>;
  onClearProof: () => void;
  chargeError: string | null;
  chargeDisabledReason: string | null;
  canCharge: boolean;
  isChargePending: boolean;
  onCharge: () => void;
  /**
   * Task 209.29 — lets the stepped/mobile checkout split this single form
   * across steps (Payment fields, then a scrollable Proof area, then a
   * structurally separate Confirm control) instead of rendering everything
   * in one long scroll behind a compressed desktop sidebar. `'confirm'` is
   * its own group (not bundled with `'proof'`) so the Charge button can sit
   * in a `shrink-0` action bar outside whatever scrolls, per the owner's
   * "bottom action always reachable" requirement. `undefined` (the
   * two-pane/desktop default) renders every group together in the same
   * order as before this task — no behavior change there. No value/handler/
   * validation logic is duplicated between groups; this only ever gates
   * which JSX renders.
   */
  section?: 'fields' | 'proof' | 'confirm';
}

/**
 * Task 194A — the discount/payment/charge panel, split out of the terminal
 * page purely for readability and isolation from the product grid and cart
 * list above it. Unlike ProductCard/CartLineItem this is a single instance
 * (not N-per-render), and `onCharge` intentionally stays a fresh closure
 * from the caller (checkout's dependency list is too wide, and too
 * financially sensitive, to safely useCallback here) — so React.memo mostly
 * just documents "this subtree owns its own props," not a guaranteed
 * render-skip.
 *
 * Task 196 (visual redesign) — a Charge button with a visible spinner +
 * "Processing…" while pending (on top of the existing disabled={!canCharge}
 * guard, which already covers double-submit — see terminal/page.tsx's
 * handleCharge belt-and-suspenders comment), and aria-live status text so
 * screen readers hear the disabled reason/charge error without extra
 * navigation. No amount, discount, payment-method, or charge-handler logic
 * changed.
 *
 * Task 209.8 (compact redesign) — reordered to Payment Method, Discount Type
 * (+ its conditional ID/proof/promo fields), Cash Tendered/Payment
 * Reference, Change, Charge button — purely a visual reorder of the same
 * rows/fields; every value, handler, and validation rule is unchanged.
 *
 * Task 209.25 (checkout workspace architecture) — the Subtotal/Discount/
 * VAT/TOTAL breakdown that used to sit above these fields moved to
 * OrderReviewPanel (checkout-workspace.tsx): this component only ever
 * rendered inline within the permanent side cart before, and now only ever
 * renders as the Payment pane's content inside CheckoutWorkspace, so a
 * second totals readout right above the same fields would be redundant.
 * `totalAmount` is kept only to label the Charge/Confirm button itself.
 * Void/Refund Sale also moved out of this component: it's sale-level
 * functionality independent of the current cart (a supervisor must be able
 * to void a *previous* sale with an empty cart, before Checkout is even
 * reachable), so it's now a standalone entry point in the permanent cart
 * panel's header (terminal/page.tsx) instead of living inside a workspace
 * an empty cart can't open.
 */
export const PaymentFooter = memo(function PaymentFooter({
  totalAmount,
  discountType,
  onDiscountTypeChange,
  discountIdReference,
  onDiscountIdReferenceChange,
  discountProofKey,
  discountProofPreviewUrl,
  onDiscountProofSelected,
  onClearDiscountProof,
  promoAmount,
  onPromoAmountChange,
  paymentMethod,
  onPaymentMethodChange,
  isOnline,
  cashTendered,
  onCashTenderedChange,
  change,
  paymentProofKey,
  paymentProofPreviewUrl,
  onProofSelected,
  onClearProof,
  chargeError,
  chargeDisabledReason,
  canCharge,
  isChargePending,
  onCharge,
  section,
}: PaymentFooterProps) {
  const showFields = section === undefined || section === 'fields';
  const showProof = section === undefined || section === 'proof';
  const showConfirm = section === undefined || section === 'confirm';
  return (
    // Task 209.20 — `.app-pos-footer` replaces the old fixed `p-3 lg:p-2.5` /
    // `space-y-2.5 lg:space-y-1.5` pair, which keyed density purely off the
    // `lg` *width* breakpoint (so a 1920x1080 monitor and a 1366x768 laptop,
    // both >=1024px wide, got identical padding despite very different
    // vertical room).
    // Task 209.25 — no longer `sticky`/`border-t`: this now renders as the
    // sole content of CheckoutWorkspace's Payment pane (which owns its own
    // scroll region), not as a footer pinned below a separately-scrolling
    // cart-items list.
    <div className="app-pos-footer">
      {showFields && (
        <>
          {/* Task 209.8 — Payment Method surfaces before Discount Type: the cashier picks how the customer is paying first, then applies any discount on top of that. Purely a visual reorder; onPaymentMethodChange/onDiscountTypeChange and every value they carry are unchanged.
              Task 209.14 — height is density-aware via `.app-control` (36-40px on compact/standard laptops, 44px on touch/comfortable, matching --app-control-height) instead of a fixed h-11/h-9, same pattern as the terminal page's category filter tabs. */}
          <Tabs value={paymentMethod} onValueChange={(v) => onPaymentMethodChange(v as 'cash' | 'gcash' | 'maya' | 'other')}>
            <TabsList className="app-control w-full items-stretch">
              <TabsTrigger value="cash" className="h-full flex-1">
                Cash
              </TabsTrigger>
              <TabsTrigger value="gcash" className="h-full flex-1" disabled={!isOnline}>
                GCash
              </TabsTrigger>
              <TabsTrigger value="maya" className="h-full flex-1" disabled={!isOnline}>
                Maya
              </TabsTrigger>
              <TabsTrigger value="other" className="h-full flex-1" disabled={!isOnline}>
                Other
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {!isOnline && paymentMethod === 'cash' && (
            <p className="text-xs text-muted-foreground">GCash, Maya, and Other are unavailable offline — payment proof can only be captured while connected.</p>
          )}

          <Select value={discountType} onValueChange={(v) => onDiscountTypeChange(v as DiscountChoice)}>
            <SelectTrigger className="app-control">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DISCOUNT_LABELS) as DiscountChoice[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {DISCOUNT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(discountType === 'pwd' || discountType === 'senior_citizen') && (
            <Input
              className="app-control"
              placeholder="PWD / Senior Citizen ID number"
              value={discountIdReference}
              onChange={(e) => onDiscountIdReferenceChange(e.target.value)}
            />
          )}
          {discountType === 'promotional' && (
            <Input
              className="app-control"
              type="number"
              min={0}
              placeholder="Promo discount amount"
              value={promoAmount}
              onChange={(e) => onPromoAmountChange(e.target.value)}
            />
          )}

          {paymentMethod === 'cash' && (
            <div className="space-y-1">
              <Input
                className="app-control"
                type="number"
                min={0}
                placeholder="Cash tendered"
                value={cashTendered}
                onChange={(e) => onCashTenderedChange(e.target.value)}
              />
              <p className="app-pos-helper-text text-muted-foreground">Change: {formatPeso(change)}</p>
            </div>
          )}
        </>
      )}

      {showProof && (
        <>
          {(discountType === 'pwd' || discountType === 'senior_citizen') && (
            <Card className="rounded-lg shadow-none">
              {/* Task 209.23 — `CardContent`'s own default `p-4 sm:p-6` (card.tsx)
                  is a plain Tailwind utility class, and `.app-pos-proof-padding`
                  is not one twMerge recognizes as conflicting with it — both
                  would otherwise sit side by side in the DOM with the winner
                  decided by CSS cascade order rather than intent. An inline
                  style has unconditional priority over any class-based rule, so
                  the density token is the only thing that can ever govern this
                  padding. */}
              <CardContent className="app-pos-proof-padding space-y-2" style={{ padding: 'var(--app-pos-proof-padding)' }}>
                {discountProofKey ? (
                  <ProofSummary label="Discount ID proof attached" previewUrl={discountProofPreviewUrl} onClear={onClearDiscountProof} />
                ) : (
                  <ImageUpload
                    label="Discount ID Proof"
                    description="Optional — a clear photo of the PWD/Senior Citizen ID for compliance records."
                    onImageSelected={onDiscountProofSelected}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {(paymentMethod === 'gcash' || paymentMethod === 'maya' || paymentMethod === 'other') && (
            <Card className="rounded-lg shadow-none">
              <CardContent className="app-pos-proof-padding space-y-2" style={{ padding: 'var(--app-pos-proof-padding)' }}>
                {paymentProofKey ? (
                  <ProofSummary label="Payment proof attached" previewUrl={paymentProofPreviewUrl} onClear={onClearProof} />
                ) : (
                  <ImageUpload
                    label="Payment Proof"
                    description="Upload a clear screenshot or photo of the successful payment."
                    required
                    onImageSelected={onProofSelected}
                  />
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {showConfirm && (
        <>
          {chargeError && (
            <Alert variant="destructive" className="px-3 py-1.5" role="alert">
              <AlertDescription className="app-pos-helper-text">{chargeError}</AlertDescription>
            </Alert>
          )}

          {chargeDisabledReason && (
            <Alert className="border-none bg-muted px-3 py-1.5" role="status" aria-live="polite">
              <AlertDescription className="app-pos-helper-text font-medium text-foreground">{chargeDisabledReason}</AlertDescription>
            </Alert>
          )}

          {/* Task 209.20 — `touch-target` (a fixed 48px floor) used to sit
              alongside `.app-pos-cta` (the density-aware token the `pos` variant
              already applies), and `min-height:48px` always won regardless of
              density — the Charge button was never actually shrinking on
              fine-pointer laptops/desktops the way every other checkout control
              already had been. Dropping both `touch-target` and the fixed `lg`
              size lets `.app-pos-cta` (38-42px fine-pointer, 44px touch/
              comfortable — see globals.css) govern its height like everywhere
              else; touch/mobile tiers are untouched since 44px was already
              their floor either way. */}
          <Button
            variant="pos"
            className="w-full"
            disabled={!canCharge}
            aria-busy={isChargePending}
            onClick={onCharge}
          >
            {isChargePending ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
                Processing…
              </>
            ) : (
              `Charge ${formatPeso(totalAmount)}`
            )}
          </Button>
        </>
      )}
    </div>
  );
});
