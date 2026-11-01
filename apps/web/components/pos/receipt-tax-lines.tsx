import { MANUAL_TOTAL_CALCULATION, VAT_RATE_PERCENT, describeStoredSaleTax } from '@potato-corner/shared';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface ReceiptTaxLinesProps {
  sale: {
    discount_type: string | null;
    /** POS-PERF-P55R2 — absent from an older API (then the sale was VAT-calculated). */
    calculation_mode?: 'legacy_vat_v1' | 'manual_total_v1';
    vat_amount: number | null;
    /** Absent from an older API's public receipt — then only the VAT line is shown. */
    vat_exempt_amount?: number | null;
    total_amount: number;
  };
}

/**
 * POS-PERF-P50 — the receipt's tax breakdown, derived only from the amounts
 * stored on the sale (describeStoredSaleTax), never from current settings,
 * so a reprinted receipt reads exactly as it did when it was rung.
 * PWD/Senior Citizen sales are VAT-exempt in full; ordinary sales show the
 * VATable amount net of VAT, the VAT, and any non-VATable (VAT-cap) part.
 */
export function ReceiptTaxLines({ sale }: ReceiptTaxLinesProps) {
  const row = 'flex justify-between text-xs text-muted-foreground';
  // POS-PERF-P55R2 — a manual-total sale has no VAT figures: say so, never
  // show a VATable/VAT/exempt breakdown or "VAT ₱0.00".
  if (sale.calculation_mode === MANUAL_TOTAL_CALCULATION || sale.vat_amount === null) {
    return (
      <div className={row} data-testid="receipt-tax-lines">
        <span>VAT not calculated by this checkout</span>
      </div>
    );
  }
  const vatAmount = sale.vat_amount;
  if (sale.vat_exempt_amount === undefined || sale.vat_exempt_amount === null) {
    return (
      <div className={row}>
        <span>VAT ({VAT_RATE_PERCENT}%)</span>
        <span className="tabular-nums">{formatPeso(vatAmount)}</span>
      </div>
    );
  }
  const breakdown = describeStoredSaleTax({ ...sale, vat_amount: vatAmount, vat_exempt_amount: sale.vat_exempt_amount });
  if (breakdown.isVatExemptSale) {
    return (
      <div data-testid="receipt-tax-lines">
        <div className={row}>
          <span>VAT-exempt sale (PWD/Senior)</span>
          <span className="tabular-nums">{formatPeso(breakdown.vatExemptSales)}</span>
        </div>
        <div className={row}>
          <span>VAT</span>
          <span className="tabular-nums">{formatPeso(breakdown.vatAmount)}</span>
        </div>
      </div>
    );
  }
  return (
    <div data-testid="receipt-tax-lines">
      <div className={row}>
        <span>VATable sales</span>
        <span className="tabular-nums">{formatPeso(breakdown.vatableSales)}</span>
      </div>
      <div className={row}>
        <span>VAT ({VAT_RATE_PERCENT}%)</span>
        <span className="tabular-nums">{formatPeso(breakdown.vatAmount)}</span>
      </div>
      {breakdown.nonVatableAmount > 0 && (
        <div className={row}>
          <span>Non-VATable amount</span>
          <span className="tabular-nums">{formatPeso(breakdown.nonVatableAmount)}</span>
        </div>
      )}
    </div>
  );
}
