import type { ReactNode } from 'react';

/**
 * POS-PERF-P56 — collapsed home for legacy settings. Its contents stay mounted
 * and keep working exactly as before: older POS versions and past sales still
 * depend on them. POS-PERF-P57 — the current checkout does not offer these.
 */
export function LegacyDiscountSettings({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-lg border" data-testid="legacy-discount-settings">
      <summary className="cursor-pointer list-inside rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">Legacy discount and VAT settings</span>
        <span className="mt-1 block text-sm text-muted-foreground">
          Only for terminals still running an older POS version, and the record of past sales. The current checkout offers only your Discount types.
        </span>
      </summary>
      <div className="space-y-4 border-t p-4">{children}</div>
    </details>
  );
}
