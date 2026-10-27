'use client';

import { memo, useRef, useState } from 'react';
import { AlertTriangle, Utensils } from 'lucide-react';
import type { PosCatalogProduct } from '@potato-corner/shared';
import { Card } from '@/components/ui/card';
import { POS_CARD_CLASSES } from './product-card-layout';

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
 *
 * POS-PERF-P39 — the tile's box comes from POS_CARD_CLASSES (shared with
 * ProductCardSkeleton): a fixed-ratio image area that the photo, the
 * placeholder and the skeleton all fill identically, and fixed-height text
 * rows. Text that doesn't fit is truncated visually only — the full name,
 * size and reason stay in the accessible label and the hover title.
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

  // POS-PERF-P24 — stock_status is a separate dimension from live_ready
  // (config/BOM readiness): a variant can be fully configured and still be
  // out_of_stock, or vice versa. A confirmed out_of_stock blocks the tile the
  // same way a readiness failure does; low_stock never blocks — it's purely
  // informational (the badge below). 'unknown' (not reliably calculable, or
  // stale) is never treated as unavailable.
  const stockOut = variant.stock_status === 'out_of_stock';
  const isAvailable = variant.live_ready && !stockOut;
  const stockBadgeLabel = variant.stock_status === 'out_of_stock' ? 'Out of Stock' : variant.stock_status === 'low_stock' ? 'Low Stock' : null;
  const ariaLabel = `${product.name}, ${variant.name}, ${formatPeso(variant.price)}${stockBadgeLabel ? `, ${stockBadgeLabel}` : ''}${message ? `, ${message}` : ''}`;

  return (
    <Card
      key={variant.id}
      role="button"
      tabIndex={isAvailable ? 0 : -1}
      aria-disabled={!isAvailable}
      aria-label={ariaLabel}
      data-render-count={renderCountRef.current}
      className={`group ${POS_CARD_CLASSES.frame} outline-none transition-all duration-150 touch-target focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
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
      <div className={POS_CARD_CLASSES.image}>
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
        {!variant.live_ready && (
          <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 shadow-sm" aria-hidden="true">
            <AlertTriangle className="h-3 w-3 text-destructive" />
          </div>
        )}
        {stockBadgeLabel && (
          <span
            className={`absolute left-1 top-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm ${
              stockBadgeLabel === 'Out of Stock' ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground'
            }`}
          >
            {stockBadgeLabel}
          </span>
        )}
      </div>

      {/* POS-PERF-P39 — every row has a fixed height (POS_CARD_CLASSES), so a
          one-line name, a missing size, a long size label or an unavailable
          reason never changes the tile's height (Task 209.24/209.56E reserved
          some of these with min-heights, which still let a long reason or
          name grow one tile past its row). A plain div, not CardContent:
          CardContent's responsive `sm:p-6 sm:pt-0` survived the `p-2`
          override and gave the tile 0 top / 24px side padding from 640px up. */}
      <div className={POS_CARD_CLASSES.body}>
        <p className={`${POS_CARD_CLASSES.name} line-clamp-2 text-sm font-semibold leading-tight text-foreground`} title={product.name}>
          {product.name}
        </p>
        <p className={`${POS_CARD_CLASSES.size} truncate text-xs leading-4 text-muted-foreground`} title={variant.name}>
          {variant.name}
        </p>
        <div className={`${POS_CARD_CLASSES.price} flex items-center justify-between gap-1`}>
          <p className="text-sm font-bold leading-5 tabular-nums text-foreground">{formatPeso(variant.price)}</p>
        </div>
        <div className={POS_CARD_CLASSES.message}>
          {message && (
            <p
              className="line-clamp-1 rounded-md bg-destructive/10 px-1.5 py-1 text-[11px] font-medium leading-snug text-destructive"
              title={message}
            >
              {message}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
});
