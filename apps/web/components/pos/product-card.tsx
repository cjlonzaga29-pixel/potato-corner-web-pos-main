'use client';

import { memo, useRef, useState } from 'react';
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
 * standing in for a product photo, stronger name/price typography, and a
 * clearer unavailable state. No change to what data is read from
 * `product`/`variant` or when `onTap` fires.
 *
 * Task 209.7 — product.image_url (a short-lived signed Storage URL, present
 * whenever product.has_image is true) renders in the tile's image area when
 * available. Falls back to the same Utensils icon tile used before this
 * task whenever there's no image, the image fails to load, or the signed
 * URL expired — a broken photo never blocks a sale.
 */
export const ProductCard = memo(function ProductCard({ product, variant, message, onTap }: ProductCardProps) {
  // Test-only visibility into actual re-render count (React.memo bails out
  // before this body runs at all, so this ref only advances on a real
  // render) — a plain data attribute, not read or relied on by any
  // production code path.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  // Tracks the last image_url that failed to load so a fresh signed URL
  // (e.g. after a catalog refetch) automatically gets a clean retry instead
  // of staying stuck on the placeholder.
  const [erroredImageUrl, setErroredImageUrl] = useState<string | null>(null);
  const showImage = product.has_image && Boolean(product.image_url) && product.image_url !== erroredImageUrl;

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
      className={`group app-pos-card flex flex-col self-start overflow-hidden rounded-xl border shadow-none outline-none transition-all duration-150 touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
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
      <div className="app-pos-card-image relative flex items-center justify-center overflow-hidden bg-muted/40">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL, not an optimizable static/remote asset (see next.config.ts)
          <img
            src={product.image_url ?? undefined}
            alt={`${product.name} - ${variant.name}`}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            onError={() => setErroredImageUrl(product.image_url)}
          />
        ) : (
          <div
            className={`flex h-1/3 w-1/3 items-center justify-center rounded-lg ${
              isAvailable ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}
            aria-hidden="true"
          >
            <Utensils className="h-1/2 w-1/2" />
          </div>
        )}
        {!isAvailable && (
          <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 shadow-sm" aria-hidden="true">
            <AlertTriangle className="h-3 w-3 text-destructive" />
          </div>
        )}
      </div>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-1 p-2.5">
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
