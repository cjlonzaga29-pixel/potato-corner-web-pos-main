import type { ReactNode } from 'react';

/**
 * POS-PERF-P56 — collapsed home for statutory and legacy settings, below the
 * Discount types cashiers actually use. Its contents stay mounted and keep
 * working exactly as before; PWD/Senior rates, VAT registration and older
 * clients still depend on them.
 */
export function LegacyDiscountSettings({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-lg border" data-testid="legacy-discount-settings">
      <summary className="cursor-pointer list-inside rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">Statutory &amp; legacy VAT settings</span>
        <span className="mt-1 block text-sm text-muted-foreground">
          PWD and Senior Citizen discounts, VAT registration, and the automatic rates older app versions and past sales used. Manual Discount Types
          above are what cashiers use at checkout.
        </span>
      </summary>
      <div className="space-y-4 border-t p-4">{children}</div>
    </details>
  );
}
