import Link from 'next/link';
import { ChevronRight, PackageCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import type { UnsellableVariant } from '@/lib/pos-product-availability';

const MAX_VISIBLE = 8;

interface DashboardProductAvailabilityProps {
  variants: UnsellableVariant[] | undefined;
  isLoading: boolean;
  isError: boolean;
  href: string;
}

/**
 * POS-PERF-P56 — product sizes the POS can't sell at this branch. Counted
 * separately from inventory alerts on purpose: one empty ingredient can block
 * many sizes, and a size can be blocked by an item that still has some stock
 * (less than one recipe needs), so the two counts are not expected to match.
 */
export function DashboardProductAvailability({ variants, isLoading, isError, href }: DashboardProductAvailabilityProps) {
  const visible = variants?.slice(0, MAX_VISIBLE) ?? [];
  const remaining = (variants?.length ?? 0) - visible.length;

  return (
    <Card>
      <CardHeader className="app-card-padding flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">POS product sizes that can&apos;t be sold{variants && variants.length > 0 ? ` (${variants.length})` : ''}</CardTitle>
        <Link
          href={href}
          className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Products
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent className="app-card-padding pt-0">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn&apos;t check the POS catalog for this branch.
          </p>
        ) : visible.length === 0 ? (
          <EmptyState compact icon={PackageCheck} title="Every POS product can be sold" description="Products turned off by a supervisor aren't on the POS, so they aren't listed here." />
        ) : (
          <div className="divide-y divide-border/60">
            {visible.map((variant) => (
              <div key={variant.key} className="grid gap-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words font-medium">
                    {variant.productName} · {variant.variantName}
                  </span>
                  <Badge variant={variant.kind === 'stock' ? 'critical' : 'warning'}>{variant.kind === 'stock' ? 'Ingredient shortage' : 'Setup incomplete'}</Badge>
                </div>
                <p className="break-words text-xs text-muted-foreground">{variant.reason}</p>
              </div>
            ))}
            {remaining > 0 && <p className="pt-2 text-xs text-muted-foreground">and {remaining} more</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
