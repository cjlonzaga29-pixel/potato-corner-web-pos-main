'use client';

import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

function formatPriceAdjustment(amount: number): string {
  if (amount === 0) return 'Included';
  const sign = amount > 0 ? '+' : '−';
  return `${sign}₱${Math.abs(amount).toFixed(2)}`;
}

interface OptionChoiceCardProps {
  name: string;
  priceAdjustment: number;
  /** Toggle mode: whether this choice is picked. Left out, the card is a plain pick-now button with no selected state (the flavor picker). Ignored in quantity mode. */
  selected?: boolean;
  /** Quantity mode when set: tapping the card adds one, and a separate Remove-one control takes one away. */
  quantity?: number;
  /** The card can't take another pick right now (a selection limit is reached). Kept focusable — see below. */
  addDisabled?: boolean;
  onActivate: () => void;
  onDecrement?: () => void;
}

const CARD_BASE =
  'flex min-h-[3.5rem] min-w-0 rounded-lg border text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/**
 * P46 — one POS customization choice (a flavor, size or add-on) as a single
 * tappable card: the whole card is the button, with the name, its price
 * change and the selection state all inside it.
 *
 * Toggle mode is a pressed/unpressed button (single- and multiple-choice
 * groups alike; the parent decides what a tap means). Quantity mode adds one
 * per tap and shows the running count as a badge; the "Remove one" control
 * is a sibling of the card's button, never nested inside it, so one tap can
 * never reach both handlers.
 *
 * A control that can't act right now is aria-disabled rather than disabled:
 * a native `disabled` drops keyboard focus to <body> the instant a limit is
 * reached under the cashier's finger, which inside a modal loses their place.
 */
export function OptionChoiceCard({ name, priceAdjustment, selected, quantity, addDisabled = false, onActivate, onDecrement }: OptionChoiceCardProps) {
  const priceText = formatPriceAdjustment(priceAdjustment);

  if (quantity === undefined) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        aria-disabled={addDisabled && !selected ? true : undefined}
        onClick={() => {
          if (addDisabled && !selected) return;
          onActivate();
        }}
        className={cn(
          CARD_BASE,
          'items-center gap-3 px-3 py-2.5',
          selected ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-input bg-background hover:bg-accent',
          addDisabled && !selected && 'cursor-not-allowed opacity-50 hover:bg-background',
        )}
      >
        {selected !== undefined && (
          <span
            aria-hidden="true"
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
            )}
          >
            {selected && <Check className="h-3 w-3" strokeWidth={3} />}
          </span>
        )}
        <span className="min-w-0 flex-1 break-words font-medium">{name}</span>
        <span className={cn('shrink-0 tabular-nums', priceAdjustment === 0 ? 'text-xs text-muted-foreground' : 'font-semibold')}>{priceText}</span>
      </button>
    );
  }

  const picked = quantity > 0;
  return (
    <div
      className={cn(
        CARD_BASE,
        'items-stretch focus-within:ring-0',
        picked ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-input bg-background',
        addDisabled && !picked && 'opacity-50',
      )}
    >
      <button
        type="button"
        aria-label={`Add one ${name}`}
        aria-disabled={addDisabled ? true : undefined}
        onClick={() => {
          if (addDisabled) return;
          onActivate();
        }}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-l-lg px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          !picked && 'rounded-r-lg',
          addDisabled ? 'cursor-not-allowed' : 'hover:bg-accent/60',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium">{name}</span>
          <span className={cn('block tabular-nums', priceAdjustment === 0 ? 'text-xs text-muted-foreground' : 'text-xs font-semibold')}>{priceText}</span>
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-2 text-sm font-bold tabular-nums',
            picked ? 'bg-primary text-primary-foreground' : 'border border-dashed border-input text-muted-foreground',
          )}
        >
          {picked ? `×${quantity}` : '+'}
        </span>
      </button>
      {/* Rendered only while something is picked, so an empty card stays one clean tap target; when the last one is removed focus moves back to the card itself. */}
      {picked && (
        <button
          type="button"
          aria-label={`Remove one ${name}`}
          onClick={(event) => {
            const card = event.currentTarget.previousElementSibling;
            onDecrement?.();
            if (quantity === 1 && card instanceof HTMLElement) card.focus();
          }}
          className="flex w-12 shrink-0 items-center justify-center rounded-r-lg border-l border-primary/30 text-primary hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Minus className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {picked ? `${name}: ${quantity} selected` : ''}
      </span>
    </div>
  );
}
