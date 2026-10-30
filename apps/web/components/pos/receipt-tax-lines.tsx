import { VAT_RATE_PERCENT, describeStoredSaleTax } from '@potato-corner/shared';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface ReceiptTaxLinesProps {
  sale: {
    discount_type: string | null;
    vat_amount: number;
    /** Absent from an older API's public receipt — then only the VAT line is shown. */
    vat_exempt_amount?: number;
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
  if (sale.vat_exempt_amount === undefined) {
    return (
      <div className={row}>
        <span>VAT ({VAT_RATE_PERCENT}%)</span>
        <span className="tabular-nums">{formatPeso(sale.vat_amount)}</span>
      </div>
    );
  }
  const breakdown = describeStoredSaleTax({ ...sale, vat_exempt_amount: sale.vat_exempt_amount });
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
