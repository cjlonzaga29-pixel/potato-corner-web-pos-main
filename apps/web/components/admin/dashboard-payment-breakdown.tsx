import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PaymentMethodGrid } from '@/components/shared/dashboard/payment-method-grid';
import type { PaymentBreakdown } from '@/hooks/queries/use-branches';

interface DashboardPaymentBreakdownProps {
  breakdown: PaymentBreakdown | undefined;
  isLoading: boolean;
}

/** Super admin dashboard — today's sales split by payment method (Cash / GCash / PayMaya / Other), aggregated across accessible branches. */
export function DashboardPaymentBreakdown({ breakdown, isLoading }: DashboardPaymentBreakdownProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Payment Breakdown (Today)</CardTitle>
      </CardHeader>
      <CardContent>
        <PaymentMethodGrid breakdown={breakdown} isLoading={isLoading} labels={{ maya: 'PayMaya' }} />
      </CardContent>
    </Card>
  );
}
