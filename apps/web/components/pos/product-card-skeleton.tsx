import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { POS_CARD_CLASSES } from './product-card-layout';

/**
 * POS-PERF-P39 — a loading POS tile built from the same box as ProductCard
 * (POS_CARD_CLASSES), so the grid doesn't move when the catalog arrives.
 * Before P39 the skeleton was a bare `.app-pos-card` div, which sized itself
 * to about half a real tile.
 */
export function ProductCardSkeleton() {
  return (
    <Card className={POS_CARD_CLASSES.frame} data-testid="pos-product-card-skeleton">
      <Skeleton className={`${POS_CARD_CLASSES.image} rounded-none`} />
      <div className={POS_CARD_CLASSES.body}>
        <div className={POS_CARD_CLASSES.name}>
          <Skeleton className="h-3.5 w-4/5" />
        </div>
        <Skeleton className={`${POS_CARD_CLASSES.size} w-1/2`} />
        <div className={`${POS_CARD_CLASSES.price} flex items-center`}>
          <Skeleton className="h-4 w-1/3" />
        </div>
        <div className={POS_CARD_CLASSES.message} />
      </div>
    </Card>
  );
}
