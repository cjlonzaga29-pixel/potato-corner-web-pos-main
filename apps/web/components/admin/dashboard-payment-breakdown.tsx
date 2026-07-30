import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import type { PaymentBreakdown } from '@/hooks/queries/use-branches';

interface DashboardPaymentBreakdownProps {
  breakdown: PaymentBreakdown | undefined;
  isLoading: boolean;
}

const ROWS: Array<{ key: keyof PaymentBreakdown; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'gcash', label: 'GCash' },
  { key: 'maya', label: 'PayMaya' },
];

/** Super admin dashboard — today's sales split by payment method (Cash / GCash / PayMaya), aggregated across accessible branches. */
export function DashboardPaymentBreakdown({ breakdown, isLoading }: DashboardPaymentBreakdownProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Payment Breakdown (Today)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            {ROWS.map((row) => (
              <Skeleton key={row.key} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          ROWS.map((row) => (
            <div key={row.key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-medium tabular-nums">{formatCurrency(breakdown?.[row.key]?.total ?? 0)}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
