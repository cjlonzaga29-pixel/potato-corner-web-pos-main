'use client';

import { computePromotionUnitDiscount, computeSaleTax, type PromotionDiscountKind, type PromotionEligibleProduct } from '@potato-corner/shared';
import { formatCurrency } from '@/lib/utils';

interface PromotionPricePreviewProps {
  products: PromotionEligibleProduct[];
  discountKind: PromotionDiscountKind;
  discountValue: number;
}

const NO_RATES = { pwd: 20, senior_citizen: 20, employee: 20 };

/**
 * POS-PERF-P49 — original price, discount and final price per size, computed
 * with the same shared function the API uses at checkout. Base size price
 * only: flavor premiums and add-ons are never discounted.
 *
 * POS-PERF-P50R — also the taxable (VATable) amount and VAT of one unit,
 * from computeSaleTax (checkout's calculation): the discount is taxable, so
 * VAT is the 12/112 share of the discounted price.
 */
export function PromotionPricePreview({ products, discountKind, discountValue }: PromotionPricePreviewProps) {
  const rows = products.flatMap((product) =>
    product.variants
      .filter((variant) => variant.is_active)
      .map((variant) => {
        const discount = computePromotionUnitDiscount(variant.base_price, discountKind, discountValue);
        const tax = computeSaleTax(variant.base_price, [{ lineTotal: variant.base_price, quantity: 1, vatableCapAmount: null, promotionDiscount: discount }], null, NO_RATES);
        return {
          vat: tax.vatAmount,
          vatable: Math.round((tax.totalAmount - tax.vatAmount) * 100) / 100,
          key: variant.id,
          label: `${product.name} — ${variant.name}`,
          original: variant.base_price,
          discount,
          final: Math.round((variant.base_price - discount) * 100) / 100,
          capped: discountKind === 'fixed_amount' && discountValue > variant.base_price,
        };
      }),
  );

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Select at least one product to see its prices.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm" aria-label="Price preview">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Item (size)</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Original</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Discount</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Taxable (net of VAT)</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">VAT</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Final</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t">
              <td className="px-3 py-2">
                {row.label}
                {row.capped && <span className="block text-xs text-amber-700 dark:text-amber-400">Capped at the item price — sells for ₱0.00</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(row.original)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">−{formatCurrency(row.discount)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(row.vatable)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(row.vat)}</td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(row.final)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
