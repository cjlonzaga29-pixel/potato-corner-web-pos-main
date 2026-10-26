import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ProductApiError, PublicationNotConfirmedError } from '@/hooks/queries/use-products';

/**
 * POS-PERF-P38 — a failed product write stays on screen until the next
 * attempt (a toast disappears). Only an actual SERVICE_WRITE_GATE_CLOSED
 * response is described as maintenance; anything else shows its own message.
 * POS-PERF-P38R — shared by the Product Builder and the product page.
 * POS-PERF-P38R3 — a publish whose answer was lost is never shown as a plain
 * failure: it says what the server's current state showed, or that it could
 * not be confirmed, and offers a read-only "Check again".
 */
export function ProductWriteError({
  error,
  failedTitle,
  pausedTitle,
  testId = 'product-write-error',
  onCheckAgain,
  checking = false,
}: {
  error: Error;
  failedTitle: string;
  pausedTitle: string;
  testId?: string;
  onCheckAgain?: () => void;
  checking?: boolean;
}) {
  if (error instanceof PublicationNotConfirmedError) {
    const unknown = error.outcome === 'unknown';
    return (
      <Alert variant={unknown ? 'default' : 'destructive'} data-testid={testId} data-outcome={error.outcome}>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{unknown ? 'Could not confirm whether this was added to POS' : 'Not on POS yet'}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            {unknown
              ? "The server didn't answer, and its current state couldn't be checked either. It may already be on POS. Check again before trying to add it."
              : "The server didn't answer, so we checked: it isn't on POS yet. If the earlier attempt is still finishing, it will show up when you check again. Trying again is safe: it never adds anything twice."}{' '}
            Nothing you entered was lost.
          </p>
          {onCheckAgain && (
            <Button type="button" variant="outline" size="sm" onClick={onCheckAgain} disabled={checking}>
              {checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Check again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

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
