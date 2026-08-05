'use client';

import { memo } from 'react';
import { CheckCircle2, Loader2, Receipt } from 'lucide-react';
import type { ImageProofType } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ImageUpload } from '@/components/shared/forms/image-upload';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
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
  subtotal: number;
  vatAmount: number;
  discountAmount: number;
  totalAmount: number;
  canManageVoidRefund: boolean;
  onOpenVoidRefund: () => void;
  discountType: DiscountChoice;
  onDiscountTypeChange: (value: DiscountChoice) => void;
  discountIdReference: string;
  onDiscountIdReferenceChange: (value: string) => void;
  promoAmount: string;
  onPromoAmountChange: (value: string) => void;
  paymentMethod: 'cash' | 'gcash' | 'maya' | 'other';
  onPaymentMethodChange: (value: 'cash' | 'gcash' | 'maya' | 'other') => void;
  isOnline: boolean;
  cashTendered: string;
  onCashTenderedChange: (value: string) => void;
  change: number;
  paymentProofKey: string | null;
  onProofSelected: (file: File, type: ImageProofType) => void;
  onClearProof: () => void;
  chargeError: string | null;
  chargeDisabledReason: string | null;
  canCharge: boolean;
  isChargePending: boolean;
  onCharge: () => void;
}

/**
 * Task 194A — the totals/discount/payment/charge panel, split out of the
 * terminal page purely for readability and isolation from the product grid
 * and cart list above it. Unlike ProductCard/CartLineItem this is a single
 * instance (not N-per-render), and `onCharge` intentionally stays a fresh
 * closure from the caller (checkout's dependency list is too wide, and too
 * financially sensitive, to safely useCallback here) — so React.memo mostly
 * just documents "this subtree owns its own props," not a guaranteed
 * render-skip.
 *
 * Task 196 (visual redesign) — stronger totals hierarchy, a Charge button
 * with a visible spinner + "Processing…" while pending (on top of the
 * existing disabled={!canCharge} guard, which already covers double-submit —
 * see terminal/page.tsx's handleCharge belt-and-suspenders comment), and
 * aria-live status text so screen readers hear the disabled reason/charge
 * error without extra navigation. No amount, discount, payment-method, or
 * charge-handler logic changed.
 */
export const PaymentFooter = memo(function PaymentFooter({
  subtotal,
  vatAmount,
  discountAmount,
  totalAmount,
  canManageVoidRefund,
  onOpenVoidRefund,
  discountType,
  onDiscountTypeChange,
  discountIdReference,
  onDiscountIdReferenceChange,
  promoAmount,
  onPromoAmountChange,
  paymentMethod,
  onPaymentMethodChange,
  isOnline,
  cashTendered,
  onCashTenderedChange,
  change,
  paymentProofKey,
  onProofSelected,
  onClearProof,
  chargeError,
  chargeDisabledReason,
  canCharge,
  isChargePending,
  onCharge,
}: PaymentFooterProps) {
  return (
    <div className="sticky bottom-0 z-10 space-y-4 border-t bg-card p-4 lg:static">
      <div className="space-y-1.5 text-sm" aria-label="Order totals">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="tabular-nums">{formatPeso(subtotal)}</span>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>VAT (12%)</span>
          <span className="tabular-nums">{formatPeso(vatAmount)}</span>
        </div>
        {discountAmount > 0 && (
          <div className="flex justify-between font-medium text-destructive">
            <span>Discount</span>
            <span className="tabular-nums">-{formatPeso(discountAmount)}</span>
          </div>
        )}
        <Separator className="my-2" />
        <div className="flex items-baseline justify-between rounded-lg bg-primary/5 px-3 py-2">
          <span className="text-base font-semibold">Total</span>
          <span className="flex items-center gap-1.5 text-2xl font-bold tabular-nums text-primary">
            <Receipt className="h-5 w-5 text-primary/70" aria-hidden="true" />
            {formatPeso(totalAmount)}
          </span>
        </div>
      </div>

      {canManageVoidRefund && (
        <Button
          type="button"
          variant="outline"
          className="touch-target w-full border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onOpenVoidRefund}
        >
          Void / Refund Sale
        </Button>
      )}

      <Select value={discountType} onValueChange={(v) => onDiscountTypeChange(v as DiscountChoice)}>
        <SelectTrigger className="touch-target">
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
          className="touch-target"
          placeholder="PWD / Senior Citizen ID number"
          value={discountIdReference}
          onChange={(e) => onDiscountIdReferenceChange(e.target.value)}
        />
      )}
      {discountType === 'promotional' && (
        <Input
          className="touch-target"
          type="number"
          min={0}
          placeholder="Promo discount amount"
          value={promoAmount}
          onChange={(e) => onPromoAmountChange(e.target.value)}
        />
      )}

      <Tabs value={paymentMethod} onValueChange={(v) => onPaymentMethodChange(v as 'cash' | 'gcash' | 'maya' | 'other')}>
        <TabsList className="h-11 w-full">
          <TabsTrigger value="cash" className="h-9 flex-1">
            Cash
          </TabsTrigger>
          <TabsTrigger value="gcash" className="h-9 flex-1" disabled={!isOnline}>
            GCash
          </TabsTrigger>
          <TabsTrigger value="maya" className="h-9 flex-1" disabled={!isOnline}>
            Maya
          </TabsTrigger>
          <TabsTrigger value="other" className="h-9 flex-1" disabled={!isOnline}>
            Other
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {!isOnline && paymentMethod === 'cash' && (
        <p className="text-xs text-muted-foreground">GCash, Maya, and Other are unavailable offline — payment proof can only be captured while connected.</p>
      )}

      {paymentMethod === 'cash' && (
        <div className="space-y-1">
          <Input
            className="touch-target"
            type="number"
            min={0}
            placeholder="Cash tendered"
            value={cashTendered}
            onChange={(e) => onCashTenderedChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Change: {formatPeso(change)}</p>
        </div>
      )}

      {(paymentMethod === 'gcash' || paymentMethod === 'maya' || paymentMethod === 'other') && (
        <Card className="rounded-lg shadow-none">
          <CardContent className="space-y-3 p-3">
            {paymentProofKey ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-success bg-success/10 px-3 py-2 text-xs text-success">
                <span className="flex min-w-0 items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Payment proof attached
                </span>
                <Button type="button" variant="ghost" size="sm" className="h-auto shrink-0 p-0 text-xs underline" onClick={onClearProof}>
                  Replace
                </Button>
              </div>
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

      {chargeError && (
        <Alert variant="destructive" className="px-3 py-2" role="alert">
          <AlertDescription className="text-xs">{chargeError}</AlertDescription>
        </Alert>
      )}

      {chargeDisabledReason && (
        <Alert className="border-none bg-muted px-3 py-2" role="status" aria-live="polite">
          <AlertDescription className="text-sm font-medium text-foreground">{chargeDisabledReason}</AlertDescription>
        </Alert>
      )}

      <Button
        variant="pos"
        className="touch-target w-full"
        size="lg"
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
    </div>
  );
});
