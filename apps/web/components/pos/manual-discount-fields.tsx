'use client';

import { AlertTriangle } from 'lucide-react';
import type { ImageProofType } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

export type ManualDiscountMode = 'unset' | 'none' | 'apply';

/** What the terminal tells the checkout about the manual-discount decision (POS-PERF-P55). */
export interface ManualDiscountFooterState {
  mode: ManualDiscountMode;
  onModeChange: (mode: 'none' | 'apply') => void;
  /** Active, Apply-to-POS types of this branch (empty offline). */
  types: readonly { id: string; name: string; requireProof: boolean; fixedAmount: number | null }[];
  /** 'unsupported' — the API predates manual discounts (P55 release fix). */
  typesStatus: 'loading' | 'ready' | 'error' | 'offline' | 'unsupported';
  onRetryTypes: () => void;
  /** The chosen type's id, or null (nothing chosen yet). */
  selection: string | null;
  onSelectionChange: (typeId: string) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  amountError: string | null;
  /** Largest amount allowed: the eligible items' subtotal (P55R2 — no VAT is calculated, so there is no VATable cap). */
  maxAmount: number;
  /** POS-PERF-P57 — the chosen type's fixed amount as configured; null for a staff-entered type. */
  fixedAmount: number | null;
  /** POS-PERF-P57 — what its product scope allows; shown when it differs from the order subtotal. */
  eligibleSubtotal: number;
  proofRequired: boolean;
  proofAttached: boolean;
  proofPreviewUrl: string | null;
  /** Same async/re-throw contract as the payment proof: ImageUpload shows the failure with Retry and keeps the file. */
  onProofSelected: (file: File, type: ImageProofType) => Promise<void>;
  onClearProof: () => void;
  /** Shown when the cart changed after the amount was entered; Charge stays blocked until confirmed. */
  changedTotal: { previousSubtotal: number; subtotal: number; totalAmount: number } | null;
  /** POS-PERF-P57 — a supervisor changed the chosen type on this screen; Charge stays blocked until confirmed. */
  changedSettings: { totalAmount: number } | null;
  onConfirmChangedTotal: () => void;
  /** The breakdown the cashier reviews before charging. */
  summary: { subtotal: number; label: string | null; discountAmount: number; totalAmount: number };
}

/**
 * POS-PERF-P55 — the checkout's discount decision: "No discount" or "Apply
 * discount", then one of the branch's types and, for a staff-entered type, the
 * amount in pesos. Never a percentage; nothing is applied automatically.
 *
 * POS-PERF-P57 — only types a supervisor set up for this branch are offered.
 * There are no built-in choices, and "No discount" always works, even when the
 * list is empty, loading, failed or unavailable offline.
 */
export function ManualDiscountFields({ state }: { state: ManualDiscountFooterState }) {
  const selected = state.selection !== null;
  const canApply = state.typesStatus === 'ready' && state.types.length > 0;
  const choiceInvalid = state.mode === 'unset';
  const isFixed = state.fixedAmount !== null;
  const noneEligible = selected && state.eligibleSubtotal <= 0;
  const limited = selected && Math.round(state.eligibleSubtotal * 100) !== Math.round(state.summary.subtotal * 100);
  const capped = isFixed && !noneEligible && Math.round((state.fixedAmount ?? 0) * 100) > Math.round(state.eligibleSubtotal * 100);
  return (
    <div className="space-y-2" data-testid="manual-discount-fields">
      <div role="radiogroup" aria-label="Discount" aria-invalid={choiceInvalid} className="grid grid-cols-2 gap-2">
        {(['none', 'apply'] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            role="radio"
            aria-checked={state.mode === mode}
            variant={state.mode === mode ? 'default' : 'outline'}
            className="app-control"
            disabled={mode === 'apply' && !canApply}
            onClick={() => state.onModeChange(mode)}
          >
            {mode === 'none' ? 'No discount' : 'Apply discount'}
          </Button>
        ))}
      </div>
      {choiceInvalid && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="discount-choice-prompt">
          Choose &ldquo;No discount&rdquo; or &ldquo;Apply discount&rdquo;.
        </p>
      )}

      {state.typesStatus === 'loading' && (
        <p className="text-xs text-muted-foreground" role="status">
          Loading discounts…
        </p>
      )}
      {state.typesStatus === 'offline' && <p className="text-xs text-muted-foreground">Offline — discounts need a connection.</p>}
      {state.typesStatus === 'unsupported' && (
        <p className="text-xs text-muted-foreground" role="status">
          Discounts aren&apos;t available on this server yet.
        </p>
      )}
      {state.typesStatus === 'error' && (
        <p className="text-xs text-destructive" role="alert">
          Couldn&apos;t load discounts.{' '}
          <button type="button" className="underline" onClick={state.onRetryTypes}>
            Retry
          </button>
        </p>
      )}
      {state.typesStatus === 'ready' && state.types.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="no-discounts-available">
          No discounts available. Ask your supervisor to add one.
        </p>
      )}

      {state.mode === 'apply' && canApply && (
        <>
          <Select value={state.selection ?? ''} onValueChange={state.onSelectionChange}>
            <SelectTrigger className="app-control" aria-label="Discount type">
              <SelectValue placeholder="Choose the discount type" />
            </SelectTrigger>
            <SelectContent>
              {state.types.map((type) => (
                <SelectItem key={type.id} value={type.id}>
                  {type.name}
                  {type.fixedAmount !== null ? ` · ${formatPeso(type.fixedAmount)} off` : ''}
                  {type.requireProof ? ' · photo required' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {noneEligible && (
            <p className="text-xs text-destructive" role="alert" data-testid="discount-no-eligible-items">
              No item in this order is eligible for this discount.
            </p>
          )}

          {selected && !noneEligible && limited && (
            <p className="text-xs text-muted-foreground" data-testid="discount-eligible-amount">
              Eligible items: {formatPeso(state.eligibleSubtotal)} of the {formatPeso(state.summary.subtotal)} order.
            </p>
          )}

          {selected && !noneEligible && isFixed && (
            <p className="text-xs text-muted-foreground" data-testid="discount-fixed-amount">
              {capped
                ? `${formatPeso(state.eligibleSubtotal)} off: this ${formatPeso(state.fixedAmount ?? 0)} discount stops at the eligible subtotal.`
                : `${formatPeso(state.fixedAmount ?? 0)} off the order. This amount is set by your supervisor.`}
            </p>
          )}

          {selected && !noneEligible && !isFixed && (
            <div className="space-y-1">
              <Label htmlFor="manual-discount-amount" className="text-xs">
                Discount amount (₱)
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden="true">
                  ₱
                </span>
                <Input
                  id="manual-discount-amount"
                  className="app-control pl-7 tabular-nums"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={state.amount}
                  aria-invalid={state.amountError !== null}
                  aria-describedby="manual-discount-amount-help"
                  onChange={(e) => state.onAmountChange(e.target.value)}
                />
              </div>
              <p id="manual-discount-amount-help" className={cn('text-xs', state.amountError ? 'text-destructive' : 'text-muted-foreground')}>
                {state.amountError ?? `Pesos off the order, up to ${formatPeso(state.maxAmount)}.`}
              </p>
            </div>
          )}
        </>
      )}

      {state.changedSettings && !state.changedTotal && (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="manual-discount-changed-settings">
          <p className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />A supervisor changed this discount. Amount to pay is now {formatPeso(state.changedSettings.totalAmount)}.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={state.onConfirmChangedTotal}>
            Confirm new total
          </Button>
        </div>
      )}

      {state.changedTotal && (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="manual-discount-changed-total">
          <p className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            The order changed: subtotal is now {formatPeso(state.changedTotal.subtotal)} (was {formatPeso(state.changedTotal.previousSubtotal)}). Amount to pay is
            now {formatPeso(state.changedTotal.totalAmount)}.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={state.onConfirmChangedTotal}>
            Confirm new total
          </Button>
        </div>
      )}

      <dl className="space-y-0.5 rounded-md bg-muted/40 p-2 text-sm" aria-label="Discount summary" data-testid="manual-discount-summary">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="tabular-nums">{formatPeso(state.summary.subtotal)}</dd>
        </div>
        {state.summary.label && (
          <div className="flex justify-between gap-2 text-destructive">
            <dt className="min-w-0 truncate">{state.summary.label}</dt>
            <dd className="tabular-nums">-{formatPeso(state.summary.discountAmount)}</dd>
          </div>
        )}
        <div className="flex justify-between font-semibold">
          <dt>Amount to pay</dt>
          <dd className="tabular-nums">{formatPeso(state.summary.totalAmount)}</dd>
        </div>
      </dl>
    </div>
  );
}
