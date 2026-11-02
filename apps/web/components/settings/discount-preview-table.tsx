'use client';

import { computeSaleTax, type SaleDiscountRates } from '@potato-corner/shared';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface DiscountPreviewTableProps {
  price: number;
  rates: SaleDiscountRates;
  employeeEnabled: boolean;
  /** POS-PERF-P55R2 — the manual-total checkout: only the statutory rows. */
  statutoryOnly?: boolean;
}

/**
 * POS-PERF-P50R — what one item at `price` costs under the given rates,
 * computed with computeSaleTax (the same function checkout runs), so the
 * preview cannot disagree with a real sale.
 */
export function DiscountPreviewTable({ price, rates, employeeEnabled, statutoryOnly = false }: DiscountPreviewTableProps) {
  const line = [{ lineTotal: price, quantity: 1, vatableCapAmount: null }];
  const rows = [
    ...(statutoryOnly ? [] : [{ label: 'No discount', result: computeSaleTax(price, line, null, rates) }]),
    { label: `PWD (${rates.pwd}%)`, result: computeSaleTax(price, line, 'pwd', rates) },
    { label: `Senior Citizen (${rates.senior_citizen}%)`, result: computeSaleTax(price, line, 'senior_citizen', rates) },
    ...(employeeEnabled ? [{ label: `Employee (${rates.employee}%)`, result: computeSaleTax(price, line, 'employee', rates) }] : []),
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="discount-preview">
        <caption className="mb-1 text-left text-sm font-medium">Preview: one item priced {formatPeso(price)}</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Sale</th>
            <th className="py-1 pr-2 text-right font-medium">Discount</th>
            <th className="py-1 text-right font-medium">Customer pays</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map(({ label, result }) => (
            <tr key={label} className="border-t">
              <td className="py-1 pr-2">{label}</td>
              <td className="py-1 pr-2 text-right">{result.discountAmount > 0 ? `-${formatPeso(result.discountAmount)}` : formatPeso(0)}</td>
              <td className="py-1 text-right font-semibold">{formatPeso(result.totalAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
