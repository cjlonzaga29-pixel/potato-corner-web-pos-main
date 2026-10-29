import { Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PaymentMethodGrid } from '@/components/shared/dashboard/payment-method-grid';
import { formatCurrency } from '@/lib/utils';
import type { PaymentBreakdown } from '@/hooks/queries/use-branches';

interface DashboardPaymentBreakdownProps {
  breakdown: PaymentBreakdown | undefined;
  isLoading: boolean;
}

/**
 * Super admin dashboard — financial-summary treatment for today's sales
 * split by payment method (Cash / GCash / PayMaya / Other): a total-collected
 * figure leads the card, with the per-method grid underneath as supporting
 * detail — same underlying totals as before, just reordered for hierarchy.
 */
export function DashboardPaymentBreakdown({ breakdown, isLoading }: DashboardPaymentBreakdownProps) {
  const total = breakdown ? breakdown.cash.total + breakdown.gcash.total + breakdown.maya.total + breakdown.other.total : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Wallet className="h-4 w-4" />
        </div>
        <CardTitle className="text-sm font-medium">Payment Breakdown (Today)</CardTitle>
      </CardHeader>
      {/* POS-PERF-P47 — full-width on the Admin dashboard: total on the left,
          the four methods in one row beside it on wide screens (stacked on
          tablets/phones) instead of a tall, mostly empty half-width card. */}
      <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-8">
        {isLoading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className="shrink-0">
            <div className="app-kpi-value font-bold tabular-nums">{formatCurrency(total)}</div>
            <p className="text-xs text-muted-foreground">Total collected across all methods</p>
          </div>
        )}
        <PaymentMethodGrid breakdown={breakdown} isLoading={isLoading} labels={{ maya: 'PayMaya' }} className="flex-1 lg:grid-cols-4" />
      </CardContent>
    </Card>
  );
}
