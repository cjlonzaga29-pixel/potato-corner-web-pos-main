import { describe, it, expect } from 'vitest';
import { DISCOUNT_TYPE } from '@potato-corner/shared';
import { computeAmounts } from './transactions.service.js';

/**
 * BIR reference table for computeAmounts. PWD/Senior Citizen sales are true
 * VAT-exempt (RA 9994 / RA 10754, confirmed by business owner — see
 * CLAUDE.md's PWD/Senior Citizen VAT Formula, updated 2026-07-21): no VAT is
 * charged, not even added back after the discount. Tera Mix's
 * vatableCapAmount caps the VATable portion to the Mega Mix SRP; the excess
 * is a structural (product-based) VAT exemption tracked in vatExemptAmount
 * regardless of discount type.
 */

function line(lineTotal: number, quantity: number, vatableCapAmount: number | null) {
  return {
    id: 'item-1',
    productId: 'product-1',
    productVariantId: 'variant-1',
    flavorId: null,
    productName: 'Test Product',
    variantName: 'Test Variant',
    flavorName: null,
    unitPrice: round2(lineTotal / quantity),
    quantity,
    lineTotal,
    vatableCapAmount,
    recipeVersion: 1,
    deductionLines: [],
  };
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

describe('computeAmounts — BIR reference table', () => {
  it('A: regular customer, no discount, no cap', () => {
    const result = computeAmounts(42, [line(42, 1, null)], undefined);
    expect(result).toEqual({ discountAmount: 0, vatAmount: 4.5, vatExemptAmount: 0, totalAmount: 42, discountRateUsed: null });
  });

  it('B: regular customer, no discount, Tera Mix cap', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], undefined);
    expect(result).toEqual({ discountAmount: 0, vatAmount: 15.96, vatExemptAmount: 110, totalAmount: 259, discountRateUsed: null });
  });

  it('C: PWD customer, no cap (Core Regular Fries 42)', () => {
    const result = computeAmounts(42, [line(42, 1, null)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 7.5, vatAmount: 0, vatExemptAmount: 0, totalAmount: 30, discountRateUsed: 20 });
  });

  it('D: PWD customer, Large Mix (no cap, ₱99)', () => {
    const result = computeAmounts(99, [line(99, 1, null)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 17.68, vatAmount: 0, vatExemptAmount: 0, totalAmount: 70.71, discountRateUsed: 20 });
  });

  it('E: PWD customer, Tera Mix with cap (₱259, cap 149)', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 26.61, vatAmount: 0, vatExemptAmount: 110, totalAmount: 216.43, discountRateUsed: 20 });
  });

  it('F: Senior customer, All Premium Tera Mix (₱279, cap 149)', () => {
    const result = computeAmounts(279, [line(279, 1, 149)], DISCOUNT_TYPE.SENIOR_CITIZEN);
    expect(result).toEqual({ discountAmount: 26.61, vatAmount: 0, vatExemptAmount: 130, totalAmount: 236.43, discountRateUsed: 20 });
  });

  it('G: multi-item cart with mixed caps, PWD', () => {
    const items = [line(42, 1, null), line(259, 1, 149)];
    const result = computeAmounts(301, items, DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 34.11, vatAmount: 0, vatExemptAmount: 110, totalAmount: 246.43, discountRateUsed: 20 });
  });

  it('H: employee discount respects cap', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], DISCOUNT_TYPE.EMPLOYEE);
    expect(result).toEqual({ discountAmount: 29.8, vatAmount: 12.77, vatExemptAmount: 110, totalAmount: 229.2, discountRateUsed: 20 });
  });

  // I: promotional discount rejection happens in createTransaction's early
  // guard, before computeAmounts is ever called — not exercised here, see
  // transactions.integration.test.ts / transactions.router.test.ts for that path.

  // Task 209.50 — sub-peso decimal edge cases (audit gap: nothing previously
  // exercised computeAmounts at the centavo floor, where a single Math.round
  // half-cent tie or a near-zero VAT component is most likely to reveal
  // early/late rounding drift).
  it('J: smallest possible sale (₱0.01), no discount — VAT rounds to zero, total unaffected', () => {
    const result = computeAmounts(0.01, [line(0.01, 1, null)], undefined);
    expect(result).toEqual({ discountAmount: 0, vatAmount: 0, vatExemptAmount: 0, totalAmount: 0.01, discountRateUsed: null });
  });

  it('K: sub-peso PWD sale (₱0.10) — 20% of the VAT-extracted base still rounds to a sane centavo total', () => {
    const result = computeAmounts(0.1, [line(0.1, 1, null)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 0.02, vatAmount: 0, vatExemptAmount: 0, totalAmount: 0.07, discountRateUsed: 20 });
  });
});

/**
 * Task 209.xx — configurable discount percentages (Discount Settings).
 * computeAmounts' 4th param (discountRates) is what the settings feature
 * changes; the VAT-exemption formula/classification above (PWD/Senior true
 * VAT-exempt, Employee VAT-inclusive extraction) is untouched by any of
 * these — only the rate multiplied in changes.
 */
describe('computeAmounts — configurable discount rates', () => {
  it('PWD configured to 10% (was 20%) — VAT-exempt formula unchanged, only the rate', () => {
    const result = computeAmounts(42, [line(42, 1, null)], DISCOUNT_TYPE.PWD, { pwd: 10, senior_citizen: 20, employee: 20 });
    // vatableBase = 42/1.12 = 37.5; 10% = 3.75; discountedBase = 33.75; total = 33.75
    expect(result).toEqual({ discountAmount: 3.75, vatAmount: 0, vatExemptAmount: 0, totalAmount: 33.75, discountRateUsed: 10 });
  });

  it('Senior Citizen configured to 15% (was 20%)', () => {
    const result = computeAmounts(42, [line(42, 1, null)], DISCOUNT_TYPE.SENIOR_CITIZEN, { pwd: 20, senior_citizen: 15, employee: 20 });
    // vatableBase = 42/1.12 ≈ 37.5 (float); 15% = round2(5.625) = 5.62; discountedBase = round2(37.5-5.62) = 31.88
    expect(result).toEqual({ discountAmount: 5.62, vatAmount: 0, vatExemptAmount: 0, totalAmount: 31.88, discountRateUsed: 15 });
  });

  it('Employee discount is independently configurable — changing PWD/Senior never changes it', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], DISCOUNT_TYPE.EMPLOYEE, { pwd: 5, senior_citizen: 5, employee: 30 });
    // vatableSubtotal 149 * 30% = 44.7; vatableAfterDiscount 104.3; vatAmount round2(104.3*12/112) = 11.18; total 104.3+110 = 214.3
    expect(result).toEqual({ discountAmount: 44.7, vatAmount: 11.18, vatExemptAmount: 110, totalAmount: 214.3, discountRateUsed: 30 });
  });

  it('a discount type with no configured rate (no discount selected) always returns discountRateUsed: null regardless of discountRates', () => {
    const result = computeAmounts(42, [line(42, 1, null)], undefined, { pwd: 10, senior_citizen: 15, employee: 30 });
    expect(result.discountRateUsed).toBeNull();
    expect(result.discountAmount).toBe(0);
  });
});
