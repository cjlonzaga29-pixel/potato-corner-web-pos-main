import { describe, expect, it } from 'vitest';
import { checkoutManualDiscountSchema, createManualDiscountTypeSchema, isStatutoryDiscountName, updateManualDiscountTypeSchema } from './manual-discount.schema.js';
import { createTransactionSchema, offlineTransactionItemSchema } from './transaction.schema.js';
import { computeManualDiscountSaleTax, computeSaleTax, manualDiscountEligibleSubtotal } from '../tax/sale-tax.js';

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const item = { product_id: '33333333-3333-4333-8333-333333333333', product_variant_id: '44444444-4444-4444-8444-444444444444', quantity: 1 };
const base = { branch_id: BRANCH_ID, items: [item], payment_method: 'cash', cash_tendered: 500, is_offline_transaction: false };

describe('POS-PERF-P55 manual discount schemas', () => {
  it('reserves statutory names and allows ordinary ones', () => {
    for (const name of ['PWD', 'pwd discount', 'Senior Citizen', 'SC', 'OSCA', 'Person with disability', 'Disabled']) expect(isStatutoryDiscountName(name), name).toBe(true);
    for (const name of ['Employee', 'Loyalty card', 'School promo', 'Barkada']) expect(isStatutoryDiscountName(name), name).toBe(false);
  });

  it('type editor: name and two switches only; edits need a version and a change', () => {
    expect(createManualDiscountTypeSchema.safeParse({ branch_id: BRANCH_ID, name: ' Employee ', apply_to_pos: true, require_proof: false }).data?.name).toBe('Employee');
    expect(createManualDiscountTypeSchema.safeParse({ branch_id: BRANCH_ID, name: '', apply_to_pos: true, require_proof: false }).success).toBe(false);
    expect(updateManualDiscountTypeSchema.safeParse({ expected_version: 1 }).success).toBe(false);
    expect(updateManualDiscountTypeSchema.safeParse({ require_proof: true }).success).toBe(false);
    expect(updateManualDiscountTypeSchema.safeParse({ require_proof: true, expected_version: 2 }).success).toBe(true);
  });

  it('amount: positive pesos with at most two decimals, never a percent string', () => {
    const ok = (amount: unknown) => checkoutManualDiscountSchema.safeParse({ discount_type_id: TYPE_ID, type_version: 1, amount }).success;
    expect(ok(50)).toBe(true);
    expect(ok(0.29)).toBe(true);
    expect(ok(1234.56)).toBe(true);
    for (const bad of [0, -1, 10.005, Number.NaN, Number.POSITIVE_INFINITY, '50', '10%', 1e7]) expect(ok(bad), String(bad)).toBe(false);
  });

  it('checkout: manual_discount needs the flow flag and discount_type "manual", and vice versa', () => {
    const manual = { discount_type_id: TYPE_ID, type_version: 1, amount: 50 };
    expect(createTransactionSchema.safeParse({ ...base, discount_flow: 'manual_v1', discount_type: 'manual', manual_discount: manual }).success).toBe(true);
    expect(createTransactionSchema.safeParse({ ...base, discount_type: 'manual', manual_discount: manual }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, discount_flow: 'manual_v1', manual_discount: manual }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, discount_flow: 'manual_v1', discount_type: 'manual' }).success).toBe(false);
    // Legacy payloads are unchanged.
    expect(createTransactionSchema.safeParse({ ...base, discount_type: 'employee' }).success).toBe(true);
    expect(createTransactionSchema.safeParse(base).success).toBe(true);
    expect(offlineTransactionItemSchema.safeParse({ offline_provisional_number: 'X', items: [item], payment_method: 'cash', cash_tendered: 1, client_created_at: 1 }).success).toBe(true);
  });
});

describe('POS-PERF-P55 manual discount tax', () => {
  const line = (lineTotal: number, quantity = 1, vatableCapAmount: number | null = null) => ({ lineTotal, quantity, vatableCapAmount });

  it('₱500 − ₱50 = ₱450 with VAT as the 12/112 share of what remains (same path as Employee)', () => {
    const result = computeManualDiscountSaleTax(500, [line(500)], 50);
    expect(result).toEqual({ discountAmount: 50, vatAmount: 48.21, vatExemptAmount: 0, totalAmount: 450, discountRateUsed: null });
    // Identical to an Employee discount of the same peso size (10% of ₱500).
    const employee = computeSaleTax(500, [line(500)], 'employee', { pwd: 20, senior_citizen: 20, employee: 10 });
    expect([employee.discountAmount, employee.vatAmount, employee.totalAmount]).toEqual([50, 48.21, 450]);
  });

  it('never discounts the non-VATable part above a VAT cap', () => {
    // 2 × ₱300 with a ₱250 cap: VATable ₱500, non-VATable ₱100.
    const lines = [line(600, 2, 250)];
    expect(manualDiscountEligibleSubtotal(lines)).toBe(500);
    const result = computeManualDiscountSaleTax(600, lines, 100);
    expect(result).toEqual({ discountAmount: 100, vatAmount: 42.86, vatExemptAmount: 100, totalAmount: 500, discountRateUsed: null });
  });

  it('the whole eligible subtotal leaves ₱0 and ₱0 VAT; centavos stay exact', () => {
    expect(computeManualDiscountSaleTax(112, [line(112)], 112)).toMatchObject({ totalAmount: 0, vatAmount: 0 });
    expect(computeManualDiscountSaleTax(100.1, [line(100.1)], 0.29)).toMatchObject({ discountAmount: 0.29, totalAmount: 99.81, vatAmount: 10.69 });
  });
});
