import { describe, expect, it } from 'vitest';
import { checkoutManualDiscountSchema, createManualDiscountTypeSchema, isStatutoryDiscountName, updateManualDiscountTypeSchema } from './manual-discount.schema.js';
import { createTransactionSchema, offlineTransactionItemSchema } from './transaction.schema.js';
import { computeManualTotal, computeSaleTax, resolveCalculationMode, MANUAL_TOTAL_CALCULATION, LEGACY_VAT_CALCULATION } from '../tax/sale-tax.js';

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

describe('POS-PERF-P55R2 manual-total calculation (no VAT)', () => {
  const line = (lineTotal: number, quantity = 1, vatableCapAmount: number | null = null) => ({ lineTotal, quantity, vatableCapAmount });

  it('₱500 − ₱50 = ₱450; no discount = the subtotal; nothing VAT-related is returned', () => {
    expect(computeManualTotal(500, 50)).toEqual({ discountAmount: 50, totalAmount: 450 });
    expect(computeManualTotal(500, null)).toEqual({ discountAmount: 0, totalAmount: 500 });
    // The legacy VAT calculation is unchanged and still extracts VAT from the same order.
    expect(computeSaleTax(500, [line(500)], null, { pwd: 20, senior_citizen: 20, employee: 20 })).toMatchObject({ vatAmount: 53.57, totalAmount: 500 });
  });

  it('the whole subtotal can be discounted, including the part above a VAT cap; centavos stay exact', () => {
    // 2 × ₱300 with a ₱250 cap: the legacy calculation would cap a commercial discount at ₱500.
    expect(computeManualTotal(600, 600)).toEqual({ discountAmount: 600, totalAmount: 0 });
    expect(computeManualTotal(600, 550)).toEqual({ discountAmount: 550, totalAmount: 50 });
    expect(computeManualTotal(100.1, 0.29)).toEqual({ discountAmount: 0.29, totalAmount: 99.81 });
    expect(computeManualTotal(0.3, 0.1)).toEqual({ discountAmount: 0.1, totalAmount: 0.2 });
  });

  it('a stored NULL mode is the VAT calculation; only the explicit value is manual total', () => {
    expect(resolveCalculationMode(null)).toBe(LEGACY_VAT_CALCULATION);
    expect(resolveCalculationMode(undefined)).toBe(LEGACY_VAT_CALCULATION);
    expect(resolveCalculationMode('legacy_vat_v1')).toBe(LEGACY_VAT_CALCULATION);
    expect(resolveCalculationMode('manual_total_v1')).toBe(MANUAL_TOTAL_CALCULATION);
  });

  it('tax_basis: manual total needs both rates null; the VAT calculation needs a number; unknown modes are refused', () => {
    const manualBasis = { calculation_mode: 'manual_total_v1', vat_rate: null, discount_rate: null };
    expect(createTransactionSchema.safeParse({ ...base, tax_basis: manualBasis }).success).toBe(true);
    expect(createTransactionSchema.safeParse({ ...base, tax_basis: { ...manualBasis, vat_rate: 12 } }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, tax_basis: { ...manualBasis, discount_rate: 20 } }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, tax_basis: { ...manualBasis, calculation_mode: 'no_vat' } }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, tax_basis: { vat_rate: null, discount_rate: null } }).success).toBe(false);
    // Legacy basis unchanged.
    expect(createTransactionSchema.safeParse({ ...base, tax_basis: { vat_rate: 12, discount_rate: null } }).success).toBe(true);
    const queued = { offline_provisional_number: 'X', items: [item], payment_method: 'cash', cash_tendered: 1, client_created_at: 1 };
    expect(offlineTransactionItemSchema.safeParse({ ...queued, tax_basis: manualBasis }).success).toBe(true);
    expect(offlineTransactionItemSchema.safeParse({ ...queued, tax_basis: { vat_rate: 12, discount_rate: null } }).success).toBe(true);
  });
});
