'use client';

import { ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProductImageThumbnailProps {
  hasImage: boolean;
  imageUrl: string | null | undefined;
  productName: string;
  className?: string;
}

/**
 * 48x48 rounded thumbnail for the Product Catalog list table (Task 209.6).
 * `imageUrl` comes straight from the product list response — the backend
 * batch-signs every image-bearing product's URL in one Storage call (Task
 * 209.x perf fix, mirroring getPosCatalog's Task 209.7 pattern), so this
 * component no longer fetches anything itself. Previously it called
 * useProductImage() per row, which fired one GET /:productId/image request
 * per visible product after the list loaded — a serial waterfall.
 */
export function ProductImageThumbnail({ hasImage, imageUrl, productName, className }: ProductImageThumbnailProps) {
  if (!hasImage || !imageUrl) {
    return (
      <div
        role="img"
        aria-label={`${productName} has no image`}
        className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground', className)}
      >
        <ImageIcon className="h-5 w-5" aria-hidden="true" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL, not an optimizable static asset
    <img
      src={imageUrl}
      alt={productName}
      loading="lazy"
      className={cn('h-12 w-12 shrink-0 rounded-md border object-cover', className)}
    />
  );
}
