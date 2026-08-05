'use client';

import { memo, useRef } from 'react';
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
 */
export const ProductCard = memo(function ProductCard({ product, variant, message, onTap }: ProductCardProps) {
  // Test-only visibility into actual re-render count (React.memo bails out
  // before this body runs at all, so this ref only advances on a real
  // render) — a plain data attribute, not read or relied on by any
  // production code path.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  return (
    <Card
      key={variant.id}
      role="button"
      tabIndex={variant.live_ready ? 0 : -1}
      aria-disabled={!variant.live_ready}
      data-render-count={renderCountRef.current}
      className={`flex h-full min-h-[92px] flex-col rounded-lg border shadow-none outline-none transition-colors touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        variant.live_ready ? 'cursor-pointer hover:border-primary hover:bg-muted' : 'cursor-not-allowed opacity-60'
      }`}
      onClick={() => onTap(product, variant)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTap(product, variant);
        }
      }}
    >
      <CardContent className="flex h-full flex-col gap-0.5 p-3">
        <p className="line-clamp-2 min-h-[2rem] text-xs font-medium leading-tight">{product.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">{variant.name}</p>
        <p className="mt-auto text-sm font-semibold tabular-nums">{formatPeso(variant.price)}</p>
        {message && <p className="line-clamp-2 text-[11px] font-medium text-destructive">{message}</p>}
      </CardContent>
    </Card>
  );
});
