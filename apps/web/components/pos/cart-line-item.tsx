'use client';

import { memo, useRef } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { PosCartItem, PosCartSelectedOption } from '@/stores/cart.store';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

function formatAdjustment(amount: number): string {
  return amount >= 0 ? ` (+${formatPeso(amount)})` : ` (-${formatPeso(Math.abs(amount))})`;
}

export interface CartLineSlotSelection {
  label: string;
  snackName: string;
  flavorName: string;
  pricePremium: number;
}

/** Shape terminal/page.tsx's memoized `cartLines` derives per cart item — kept here so CartLineItem's props don't depend on the page module. */
export interface CartLine {
  index: number;
  item: PosCartItem;
  productName: string;
  variantName: string;
  flavorName: string | null;
  slotSelections: CartLineSlotSelection[];
  optionSelections: PosCartSelectedOption[];
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  vatableCapAmount: number | null;
  hasOptionGroups: boolean;
}

interface CartLineItemProps {
  line: CartLine;
  showDivider: boolean;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  onQuantityChange: (index: number, quantity: number) => void;
}

/**
 * Task 194A — one cart line, split out of the terminal page's cart list and
 * wrapped in React.memo so editing/removing one line, or typing in an
 * unrelated field, doesn't re-render every other line in the cart.
 * `onEdit`/`onRemove`/`onQuantityChange` must stay stable (useCallback'd or
 * a direct Zustand store action) — a fresh function identity every render
 * defeats the memo the same way an unstable `line` object would.
 *
 * Task 196 (visual redesign) — clearer per-line hierarchy (name, variant,
 * selected flavors/add-ons visually grouped and indented, quantity stepper
 * at a full 44px+ touch target, line total emphasized) and compact spacing
 * so more lines fit the cart's independent scroll region. No change to what
 * triggers onEdit/onRemove/onQuantityChange or the values passed to them.
 *
 * Task 209.8B — further vertical compaction: edit/remove/quantity controls
 * moved off the fixed-48px `.touch-target` onto the density-aware
 * `.app-control-square` (still >=44px on compact-touch/mobile, 36-40px on
 * fine-pointer standard/compact), tighter line-height on modifier rows, and
 * smaller row gaps. No change to what data is shown or the handlers' args.
 */
export const CartLineItem = memo(function CartLineItem({ line, showDivider, onEdit, onRemove, onQuantityChange }: CartLineItemProps) {
  // Test-only visibility into actual re-render count — see product-card.tsx
  // for the same pattern and rationale.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const hasOptionDetails = line.slotSelections.length > 0 || line.optionSelections.length > 0;

  return (
    <div data-render-count={renderCountRef.current}>
      {showDivider && <Separator className="mb-1.5" />}
      <div className="space-y-1 rounded-lg text-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
              {line.productName}
              {line.flavorName ? ` — ${line.flavorName}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">
              {line.variantName} · {formatPeso(line.unitPrice)} each
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {line.hasOptionGroups && (
              <Button variant="ghost" size="icon" className="app-control-square" onClick={() => onEdit(line.index)} aria-label="Edit">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="app-control-square text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onRemove(line.index)}
              aria-label={`Remove ${line.productName} from cart`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {hasOptionDetails && (
          // Plain text nodes (no nested elements) inside each <p> — Testing
          // Library's getByText only concatenates an element's *direct*
          // text-node children, not text inside nested children, so a
          // wrapping <span> around just the label prefix would silently stop
          // "Label: rest of the line" from matching as one string.
          <div className="space-y-0 border-l-2 border-border pl-2">
            {line.slotSelections.map((sel, si) => (
              <p key={si} className="text-xs leading-tight text-muted-foreground">
                {sel.label}: {sel.snackName} — {sel.flavorName}
              </p>
            ))}
            {line.optionSelections.map((opt) => (
              <p key={opt.option_id} className="text-xs leading-tight text-muted-foreground">
                {opt.option_group_name}: {opt.option_name}
                {opt.price_adjustment !== 0 ? formatAdjustment(opt.price_adjustment) : ''}
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="app-control-square"
              aria-label={`Decrease ${line.productName} quantity`}
              onClick={(e) => {
                e.stopPropagation();
                onQuantityChange(line.index, line.item.quantity - 1);
              }}
            >
              −
            </Button>
            <span className="w-6 text-center font-medium tabular-nums">{line.item.quantity}</span>
            <Button
              variant="outline"
              size="icon"
              className="app-control-square"
              aria-label={`Increase ${line.productName} quantity`}
              onClick={(e) => {
                e.stopPropagation();
                onQuantityChange(line.index, line.item.quantity + 1);
              }}
            >
              +
            </Button>
          </div>
          <p className="text-right text-sm font-bold tabular-nums text-foreground">{formatPeso(line.lineTotal)}</p>
        </div>
      </div>
    </div>
  );
});
