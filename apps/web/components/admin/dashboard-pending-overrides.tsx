import Link from 'next/link';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import type { PriceOverrideResponse } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency } from '@/lib/utils';

const SKELETON_ROWS = 3;

interface DashboardPendingOverridesProps {
  overrides: PriceOverrideResponse[] | undefined;
  isLoading: boolean;
}

/** Row 3 (right) of the super admin dashboard — up to 5 pending price overrides. Pure display, no data fetching. */
export function DashboardPendingOverrides({ overrides, isLoading }: DashboardPendingOverridesProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">Pending Price Overrides</CardTitle>
        <Link href="/admin/approvals/price-overrides" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : !overrides || overrides.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No pending price overrides" />
        ) : (
          <div className="space-y-2">
            {overrides.map((override) => (
              <div key={override.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {override.product_name} — {override.variant_name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {override.branch_name} — {override.requested_by_name}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
                  <span className="text-muted-foreground line-through">{formatCurrency(override.master_price)}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{formatCurrency(override.requested_price)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
