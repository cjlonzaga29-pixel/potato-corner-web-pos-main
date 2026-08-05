'use client';

import { memo, useRef } from 'react';
import { AlertTriangle, Utensils } from 'lucide-react';
import type { PosCatalogProduct } from '@potato-corner/shared';
import { Card, CardContent } from '@/components/ui/card';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface ProductCardProps {
  product: PosCatalogProduct;
  variant: PosCatalogProduct['variants'][number];
  /** Cashier-facing reason this variant can't be sold right now, or null when it's live_ready. */
  message: string | null;
  onTap: (product: PosCatalogProduct, variant: PosCatalogProduct['variants'][number]) => void;
}

/**
 * Task 194A — one POS catalog tile, split out of the terminal page's product
 * grid and wrapped in React.memo so typing in an unrelated field (Cash
 * Tendered, a discount ID, a search box) or editing one cart line no longer
 * re-renders every other tile in the grid. `onTap` must stay a stable
 * (useCallback'd) reference from the caller — recreating it every render
 * would defeat the memo just as surely as an unstable `product`/`variant`.
 *
 * Task 196 (visual redesign) — larger touch target, a consistent icon tile
 * standing in for a product photo (the POS catalog payload carries no image
 * field — see packages/shared posCatalogVariantSchema — so a generated/fake
 * image is never used here), stronger name/price typography, and a clearer
 * unavailable state. No change to what data is read from `product`/`variant`
 * or when `onTap` fires.
 */
export const ProductCard = memo(function ProductCard({ product, variant, message, onTap }: ProductCardProps) {
  // Test-only visibility into actual re-render count (React.memo bails out
  // before this body runs at all, so this ref only advances on a real
  // render) — a plain data attribute, not read or relied on by any
  // production code path.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const isAvailable = variant.live_ready;
  const ariaLabel = `${product.name}, ${variant.name}, ${formatPeso(variant.price)}${message ? `, ${message}` : ''}`;

  return (
    <Card
      key={variant.id}
      role="button"
      tabIndex={isAvailable ? 0 : -1}
      aria-disabled={!isAvailable}
      aria-label={ariaLabel}
      data-render-count={renderCountRef.current}
      className={`group flex h-full min-h-[104px] flex-col overflow-hidden rounded-xl border shadow-none outline-none transition-all duration-150 touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        isAvailable
          ? 'cursor-pointer hover:-translate-y-0.5 hover:border-primary hover:shadow-md active:translate-y-0 active:scale-[0.98]'
          : 'cursor-not-allowed opacity-60'
      }`}
      onClick={() => onTap(product, variant)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTap(product, variant);
        }
      }}
    >
      <CardContent className="flex h-full flex-col gap-1 p-2.5">
        <div className="flex items-center justify-between gap-1">
          <div
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
              isAvailable ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}
            aria-hidden="true"
          >
            <Utensils className="h-3.5 w-3.5" />
          </div>
          {!isAvailable && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />}
        </div>

        <p className="line-clamp-2 min-h-[2rem] text-sm font-semibold leading-tight text-foreground">{product.name}</p>
        <p className="truncate text-xs text-muted-foreground">{variant.name}</p>

        <div className="mt-auto flex items-end justify-between gap-1 pt-0.5">
          <p className="text-sm font-bold tabular-nums text-foreground">{formatPeso(variant.price)}</p>
        </div>

        {message && (
          <p className="line-clamp-2 rounded-md bg-destructive/10 px-1.5 py-1 text-[11px] font-medium leading-snug text-destructive">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
});
