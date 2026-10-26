import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ProductApiError } from '@/hooks/queries/use-products';

/**
 * POS-PERF-P38 — a failed product write stays on screen until the next
 * attempt (a toast disappears). Only an actual SERVICE_WRITE_GATE_CLOSED
 * response is described as maintenance; anything else shows its own message.
 * POS-PERF-P38R — shared by the Product Builder and the product page.
 */
export function ProductWriteError({
  error,
  failedTitle,
  pausedTitle,
  testId = 'product-write-error',
}: {
  error: Error;
  failedTitle: string;
  pausedTitle: string;
  testId?: string;
}) {
  const paused = error instanceof ProductApiError && error.code === 'SERVICE_WRITE_GATE_CLOSED';
  return (
    <Alert variant={paused ? 'default' : 'destructive'} data-testid={testId}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{paused ? pausedTitle : failedTitle}</AlertTitle>
      <AlertDescription>
        {paused
          ? 'Changes are temporarily paused while the system is updated. Nothing was changed, and everything you entered is still here. Try again in a few minutes.'
          : `${error.message} Nothing you entered was lost.`}
      </AlertDescription>
    </Alert>
  );
}
