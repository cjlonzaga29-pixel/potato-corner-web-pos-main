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
  };
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

describe('computeAmounts — BIR reference table', () => {
  it('A: regular customer, no discount, no cap', () => {
    const result = computeAmounts(42, [line(42, 1, null)], undefined);
    expect(result).toEqual({ discountAmount: 0, vatAmount: 4.5, vatExemptAmount: 0, totalAmount: 42 });
  });

  it('B: regular customer, no discount, Tera Mix cap', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], undefined);
    expect(result).toEqual({ discountAmount: 0, vatAmount: 15.96, vatExemptAmount: 110, totalAmount: 259 });
  });

  it('C: PWD customer, no cap (Core Regular Fries 42)', () => {
    const result = computeAmounts(42, [line(42, 1, null)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 7.5, vatAmount: 0, vatExemptAmount: 0, totalAmount: 30 });
  });

  it('D: PWD customer, Large Mix (no cap, ₱99)', () => {
    const result = computeAmounts(99, [line(99, 1, null)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 17.68, vatAmount: 0, vatExemptAmount: 0, totalAmount: 70.71 });
  });

  it('E: PWD customer, Tera Mix with cap (₱259, cap 149)', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 26.61, vatAmount: 0, vatExemptAmount: 110, totalAmount: 216.43 });
  });

  it('F: Senior customer, All Premium Tera Mix (₱279, cap 149)', () => {
    const result = computeAmounts(279, [line(279, 1, 149)], DISCOUNT_TYPE.SENIOR_CITIZEN);
    expect(result).toEqual({ discountAmount: 26.61, vatAmount: 0, vatExemptAmount: 130, totalAmount: 236.43 });
  });

  it('G: multi-item cart with mixed caps, PWD', () => {
    const items = [line(42, 1, null), line(259, 1, 149)];
    const result = computeAmounts(301, items, DISCOUNT_TYPE.PWD);
    expect(result).toEqual({ discountAmount: 34.11, vatAmount: 0, vatExemptAmount: 110, totalAmount: 246.43 });
  });

  it('H: employee discount respects cap', () => {
    const result = computeAmounts(259, [line(259, 1, 149)], DISCOUNT_TYPE.EMPLOYEE);
    expect(result).toEqual({ discountAmount: 29.8, vatAmount: 12.77, vatExemptAmount: 110, totalAmount: 229.2 });
  });

  // I: promotional discount rejection happens in createTransaction's early
  // guard, before computeAmounts is ever called — not exercised here, see
  // transactions.integration.test.ts / transactions.router.test.ts for that path.
});
