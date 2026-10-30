import { describe, it, expect } from 'vitest';
import { computeSaleTax, describeStoredSaleTax, discountRateFor, type SaleDiscountType, type SaleTaxLine } from './sale-tax.js';

// Verbatim copy of transactions.service.ts computeAmounts as of 422c9ff (P49),
// before P50 moved it here. computeSaleTax must reproduce it exactly.
function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}
function legacyComputeAmounts(subtotal: number, items: SaleTaxLine[], discountType: SaleDiscountType, discountRates: { pwd: number; senior_citizen: number; employee: number }) {
  const vatableSubtotal = round2(
    items.reduce((sum, item) => {
      const cap = item.vatableCapAmount;
      const vatableLine = cap != null ? Math.min(item.lineTotal, round2(cap * item.quantity)) : item.lineTotal;
      return sum + vatableLine;
    }, 0),
  );
  const nonVatableSubtotal = round2(subtotal - vatableSubtotal);
  if (discountType === 'pwd' || discountType === 'senior_citizen') {
    const ratePercent = discountType === 'pwd' ? discountRates.pwd : discountRates.senior_citizen;
    const vatableBase = vatableSubtotal / 1.12;
    const discountAmount = round2(vatableBase * (ratePercent / 100));
    const discountedBase = round2(vatableBase - discountAmount);
    const totalAmount = round2(discountedBase + nonVatableSubtotal);
    return { discountAmount, vatAmount: 0, vatExemptAmount: nonVatableSubtotal, totalAmount, discountRateUsed: ratePercent };
  }
  let discountAmount = 0;
  let discountRateUsed: number | null = null;
  if (discountType === 'employee') {
    discountRateUsed = discountRates.employee;
    discountAmount = round2(vatableSubtotal * (discountRateUsed / 100));
  } else if (!discountType) {
    discountAmount = round2(items.reduce((sum, item) => sum + (item.promotionDiscount ?? 0), 0));
  }
  const vatableAfterDiscount = round2(vatableSubtotal - discountAmount);
  const vatAmount = round2(vatableAfterDiscount * (12 / 112));
  const totalAfterDiscount = round2(vatableAfterDiscount + nonVatableSubtotal);
  return { discountAmount, vatAmount, vatExemptAmount: nonVatableSubtotal, totalAmount: totalAfterDiscount, discountRateUsed };
}

// Small deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const RATES = { pwd: 20, senior_citizen: 20, employee: 20 };

describe('computeSaleTax', () => {
  it('reproduces the pre-P50 server formula exactly on 20,000 random carts (quantities, add-on prices, caps, promotions, every discount type)', () => {
    const next = rng(50);
    const types: SaleDiscountType[] = [undefined, null, 'pwd', 'senior_citizen', 'employee'];
    for (let run = 0; run < 20000; run += 1) {
      const lines: SaleTaxLine[] = Array.from({ length: 1 + Math.floor(next() * 5) }, () => {
        const quantity = 1 + Math.floor(next() * 7);
        const unit = round2(9 + Math.floor(next() * 40000) / 100); // ₱9.00 – ₱409.99, centavo prices
        const lineTotal = round2(unit * quantity);
        const capped = next() < 0.25;
        const promo = !capped && next() < 0.3 ? round2(Math.min(unit, Math.floor(next() * 3000) / 100) * quantity) : undefined;
        return { lineTotal, quantity, vatableCapAmount: capped ? round2(unit * (0.5 + next() * 0.6)) : null, promotionDiscount: promo };
      });
      const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
      const type = types[Math.floor(next() * types.length)];
      const rates = { pwd: 20, senior_citizen: 20, employee: Math.floor(next() * 10001) / 100 };
      expect(computeSaleTax(subtotal, lines, type, rates)).toEqual(legacyComputeAmounts(subtotal, lines, type, rates));
    }
  });

  it('ordinary sale: VAT is the 12/112 share of the VAT-inclusive price', () => {
    expect(computeSaleTax(112, [{ lineTotal: 112, quantity: 1, vatableCapAmount: null }], undefined, RATES)).toEqual({
      discountAmount: 0, vatAmount: 12, vatExemptAmount: 0, totalAmount: 112, discountRateUsed: null,
    });
  });

  it('PWD/Senior: VAT removed, 20% off the VAT-exclusive amount, no VAT charged', () => {
    for (const type of ['pwd', 'senior_citizen'] as const) {
      expect(computeSaleTax(112, [{ lineTotal: 112, quantity: 1, vatableCapAmount: null }], type, RATES)).toEqual({
        discountAmount: 20, vatAmount: 0, vatExemptAmount: 0, totalAmount: 80, discountRateUsed: 20,
      });
    }
  });

  it('VAT cap: the part above the cap is neither discounted nor taxed', () => {
    // 2 × ₱300 capped at ₱250/unit → VATable ₱500, non-VATable ₱100.
    const line = { lineTotal: 600, quantity: 2, vatableCapAmount: 250 };
    expect(computeSaleTax(600, [line], undefined, RATES)).toMatchObject({ vatAmount: 53.57, vatExemptAmount: 100, totalAmount: 600 });
    expect(computeSaleTax(600, [line], 'pwd', RATES)).toMatchObject({ discountAmount: 89.29, vatAmount: 0, vatExemptAmount: 100, totalAmount: 457.14 });
  });

  it('promotions only apply with no transaction-level discount', () => {
    const line = { lineTotal: 117, quantity: 3, vatableCapAmount: null, promotionDiscount: 30 };
    expect(computeSaleTax(117, [line], undefined, RATES)).toMatchObject({ discountAmount: 30, vatAmount: 9.32, totalAmount: 87 });
    expect(computeSaleTax(117, [line], 'employee', RATES)).toMatchObject({ discountAmount: 23.4, totalAmount: 93.6 });
  });

  it('discountRateFor reports the rate a type would use, or null', () => {
    const rates = { pwd: 20, senior_citizen: 20, employee: 15 };
    expect(discountRateFor('employee', rates)).toBe(15);
    expect(discountRateFor('pwd', rates)).toBe(20);
    expect(discountRateFor(undefined, rates)).toBeNull();
    expect(discountRateFor('promotional', rates)).toBeNull();
  });
});

describe('describeStoredSaleTax', () => {
  it('ordinary sale: VATable sales net of VAT, VAT, non-VATable cap overflow', () => {
    expect(describeStoredSaleTax({ discount_type: null, vat_amount: 53.57, vat_exempt_amount: 100, total_amount: 600 })).toEqual({
      vatableSales: 446.43, vatAmount: 53.57, vatExemptSales: 0, nonVatableAmount: 100, isVatExemptSale: false,
    });
  });

  it('PWD/Senior sale: the whole stored total is VAT-exempt', () => {
    expect(describeStoredSaleTax({ discount_type: 'senior_citizen', vat_amount: 0, vat_exempt_amount: 100, total_amount: 457.14 })).toEqual({
      vatableSales: 0, vatAmount: 0, vatExemptSales: 457.14, nonVatableAmount: 0, isVatExemptSale: true,
    });
  });
});
