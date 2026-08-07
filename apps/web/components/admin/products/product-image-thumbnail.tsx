'use client';

import { ImageIcon } from 'lucide-react';
import { useProductImage } from '@/hooks/queries/use-products';
import { cn } from '@/lib/utils';

interface ProductImageThumbnailProps {
  productId: string;
  hasImage: boolean;
  productName: string;
  className?: string;
}

/**
 * 48x48 rounded thumbnail for the Product Catalog list table (Task 209.6).
 * `hasImage` (from ProductResponse.has_image) gates the signed-URL fetch —
 * a product known to have no image never calls useProductImage, so the list
 * never mints signed URLs for products no one is viewing. Products with an
 * image show a skeleton until the signed URL resolves.
 */
export function ProductImageThumbnail({ productId, hasImage, productName, className }: ProductImageThumbnailProps) {
  const { data, isLoading } = useProductImage(productId, hasImage);

  if (!hasImage) {
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

  if (isLoading || !data?.image_url) {
    return (
      <div
        data-testid="product-thumbnail-skeleton"
        className={cn('h-12 w-12 shrink-0 animate-pulse rounded-md bg-muted', className)}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL, not an optimizable static asset
    <img src={data.image_url} alt={productName} className={cn('h-12 w-12 shrink-0 rounded-md border object-cover', className)} />
  );
}
