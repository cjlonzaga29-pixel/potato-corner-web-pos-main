'use client';

import { AlertTriangle } from 'lucide-react';
import type { ImageProofType } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

export type ManualDiscountMode = 'unset' | 'none' | 'apply';
export type StatutoryDiscountChoice = 'pwd' | 'senior_citizen';

/** What the terminal tells the checkout about the manual-discount decision (POS-PERF-P55). */
export interface ManualDiscountFooterState {
  mode: ManualDiscountMode;
  onModeChange: (mode: 'none' | 'apply') => void;
  /** Active, Apply-to-POS types of this branch (empty offline). */
  types: readonly { id: string; name: string; requireProof: boolean }[];
  typesStatus: 'loading' | 'ready' | 'error' | 'offline';
  onRetryTypes: () => void;
  /** `manual:<id>`, a statutory type, or null (nothing chosen yet). */
  selection: `manual:${string}` | StatutoryDiscountChoice | null;
  onSelectionChange: (value: `manual:${string}` | StatutoryDiscountChoice) => void;
  statutoryLabels: Record<StatutoryDiscountChoice, string>;
  statutoryAvailable: readonly StatutoryDiscountChoice[];
  amount: string;
  onAmountChange: (value: string) => void;
  amountError: string | null;
  /** Largest amount allowed (the order's VATable amount). */
  maxAmount: number;
  proofRequired: boolean;
  proofAttached: boolean;
  proofPreviewUrl: string | null;
  /** Same async/re-throw contract as the payment proof: ImageUpload shows the failure with Retry and keeps the file. */
  onProofSelected: (file: File, type: ImageProofType) => Promise<void>;
  onClearProof: () => void;
  /** Shown when the cart changed after the amount was entered; Charge stays blocked until confirmed. */
  changedTotal: { previousSubtotal: number; subtotal: number; totalAmount: number } | null;
  onConfirmChangedTotal: () => void;
  /** The breakdown the cashier reviews before charging. */
  summary: { subtotal: number; label: string | null; discountAmount: number; totalAmount: number };
}

/**
 * POS-PERF-P55 — the checkout's discount decision: "No discount" or "Apply
 * discount", then one type (a branch manual type, or the statutory PWD/Senior
 * discount, which keeps its own VAT-exempt formula) and, for a manual type,
 * the amount in pesos. Never a percentage; nothing is applied automatically.
 */
export function ManualDiscountFields({ state }: { state: ManualDiscountFooterState }) {
  const manualSelected = state.selection?.startsWith('manual:') === true;
  const choiceInvalid = state.mode === 'unset';
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

      {state.mode === 'apply' && (
        <>
          <Select value={state.selection ?? ''} onValueChange={(v) => state.onSelectionChange(v as `manual:${string}` | StatutoryDiscountChoice)}>
            <SelectTrigger className="app-control" aria-label="Discount type">
              <SelectValue placeholder="Choose the discount type" />
            </SelectTrigger>
            <SelectContent>
              {state.types.length > 0 && (
                <SelectGroup aria-label="Discount types">
                  <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Enter amount in pesos</div>
                  {state.types.map((type) => (
                    <SelectItem key={type.id} value={`manual:${type.id}`}>
                      {type.name}
                      {type.requireProof ? ' · photo required' : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {state.statutoryAvailable.length > 0 && (
                <SelectGroup aria-label="Statutory discounts (VAT-exempt)">
                  <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Statutory · VAT-exempt</div>
                  {state.statutoryAvailable.map((value) => (
                    <SelectItem key={value} value={value}>
                      {state.statutoryLabels[value]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          {state.typesStatus === 'offline' && (
            <p className="text-xs text-muted-foreground">Offline — discount types need a connection. Only the statutory discounts can be applied.</p>
          )}
          {state.typesStatus === 'error' && (
            <p className="text-xs text-destructive" role="alert">
              Couldn&apos;t load this branch&apos;s discount types.{' '}
              <button type="button" className="underline" onClick={state.onRetryTypes}>
                Retry
              </button>
            </p>
          )}
          {state.typesStatus === 'ready' && state.types.length === 0 && (
            <p className="text-xs text-muted-foreground">No discount types are set up for this branch yet. A supervisor adds them in Settings.</p>
          )}

          {manualSelected && (
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
                {state.amountError ?? `Pesos off the whole order, up to ${formatPeso(state.maxAmount)}.`}
              </p>
            </div>
          )}
        </>
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
