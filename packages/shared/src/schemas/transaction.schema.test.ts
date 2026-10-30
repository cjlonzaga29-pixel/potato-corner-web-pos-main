import { describe, it, expect } from 'vitest';
import { cartItemSchema, createTransactionSchema, offlineTransactionItemSchema } from './transaction.schema.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const OPTION_ID_1 = '33333333-3333-4333-8333-333333333333';
const OPTION_ID_2 = '44444444-4444-4444-8444-444444444444';

const VALID_CART_ITEM = {
  product_id: PRODUCT_ID,
  product_variant_id: VARIANT_ID,
  quantity: 1,
};

describe('cartItemSchema — selected_option_ids (Task 26)', () => {
  it('accepts a cart item with valid selected_option_ids', () => {
    const result = cartItemSchema.safeParse({
      ...VALID_CART_ITEM,
      selected_option_ids: [OPTION_ID_1, OPTION_ID_2],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selected_option_ids).toEqual([OPTION_ID_1, OPTION_ID_2]);
    }
  });

  it('accepts a cart item without selected_option_ids', () => {
    const result = cartItemSchema.safeParse(VALID_CART_ITEM);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selected_option_ids).toBeUndefined();
    }
  });

  it('rejects non-string (and non-UUID) option ids', () => {
    const nonStringResult = cartItemSchema.safeParse({
      ...VALID_CART_ITEM,
      selected_option_ids: [123],
    });
    expect(nonStringResult.success).toBe(false);

    const nonUuidResult = cartItemSchema.safeParse({
      ...VALID_CART_ITEM,
      selected_option_ids: ['not-a-uuid'],
    });
    expect(nonUuidResult.success).toBe(false);
  });

  it('does not accept display metadata fields as part of the trusted payload', () => {
    const result = cartItemSchema.safeParse({
      ...VALID_CART_ITEM,
      selected_option_ids: [OPTION_ID_1],
      option_group_name: 'Flavor',
      option_name: 'Cheese',
      price_adjustment: 15,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('option_group_name');
      expect(result.data).not.toHaveProperty('option_name');
      expect(result.data).not.toHaveProperty('price_adjustment');
    }
  });

  it('leaves existing selected_flavors (Mix & Max) validation unchanged', () => {
    const flavorId = '55555555-5555-4555-8555-555555555555';
    const result = cartItemSchema.safeParse({
      ...VALID_CART_ITEM,
      selected_flavors: [{ slot_index: 0, snack_product_variant_id: VARIANT_ID, flavor_id: flavorId }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selected_flavors).toEqual([
        { slot_index: 0, snack_product_variant_id: VARIANT_ID, flavor_id: flavorId },
      ]);
    }
  });
});

describe('createTransactionSchema — items with selected_option_ids', () => {
  const BASE_TRANSACTION = {
    branch_id: '66666666-6666-4666-8666-666666666666',
    payment_method: 'cash' as const,
    cash_tendered: 100,
  };

  it('accepts an item carrying selected_option_ids alongside a normal checkout payload', () => {
    const result = createTransactionSchema.safeParse({
      ...BASE_TRANSACTION,
      items: [{ ...VALID_CART_ITEM, selected_option_ids: [OPTION_ID_1] }],
    });

    expect(result.success).toBe(true);
  });

  it('accepts items without Product Options as before', () => {
    const result = createTransactionSchema.safeParse({
      ...BASE_TRANSACTION,
      items: [VALID_CART_ITEM],
    });

    expect(result.success).toBe(true);
  });
});

describe('createTransactionSchema — discount_id_reference', () => {
  const BASE_TRANSACTION = {
    branch_id: '66666666-6666-4666-8666-666666666666',
    payment_method: 'cash' as const,
    cash_tendered: 100,
    discount_type: 'pwd' as const,
    items: [VALID_CART_ITEM],
  };

  it('rejects a whitespace-only discount_id_reference — trims before the min(1) check runs', () => {
    const result = createTransactionSchema.safeParse({
      ...BASE_TRANSACTION,
      discount_id_reference: '       ',
    });

    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace off an otherwise-valid discount_id_reference', () => {
    const result = createTransactionSchema.safeParse({
      ...BASE_TRANSACTION,
      discount_id_reference: '  PWD-12345  ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.discount_id_reference).toBe('PWD-12345');
    }
  });

  it('accepts a non-empty discount_id_reference with no surrounding whitespace', () => {
    const result = createTransactionSchema.safeParse({
      ...BASE_TRANSACTION,
      discount_id_reference: 'PWD-12345',
    });

    expect(result.success).toBe(true);
  });
});

// POS-PERF-P50 — tax_basis is an optional acknowledgement of the rates the
// screen used; older clients and pre-P50 queued sales omit it.
describe('tax_basis (P50)', () => {
  const base = {
    branch_id: '11111111-1111-4111-8111-111111111111',
    items: [{ product_id: '22222222-2222-4222-8222-222222222222', product_variant_id: '33333333-3333-4333-8333-333333333333', quantity: 1 }],
    payment_method: 'cash',
    cash_tendered: 100,
  };

  it('is optional, and passes through when present', () => {
    expect(createTransactionSchema.safeParse(base).success).toBe(true);
    const parsed = createTransactionSchema.parse({ ...base, tax_basis: { vat_rate: 12, discount_rate: null } });
    expect(parsed.tax_basis).toEqual({ vat_rate: 12, discount_rate: null });
  });

  it('rejects out-of-range or non-numeric rates', () => {
    for (const tax_basis of [{ vat_rate: -1, discount_rate: null }, { vat_rate: 12, discount_rate: 101 }, { vat_rate: '12', discount_rate: null }, { vat_rate: 12 }]) {
      expect(createTransactionSchema.safeParse({ ...base, tax_basis }).success).toBe(false);
    }
  });

  it('offline items accept it too', () => {
    const item = { offline_provisional_number: 'PC-X-20261030-OFFLINE-0001', items: base.items, payment_method: 'cash', cash_tendered: 100, client_created_at: 1, tax_basis: { vat_rate: 12, discount_rate: 20 } };
    expect(offlineTransactionItemSchema.parse(item).tax_basis).toEqual({ vat_rate: 12, discount_rate: 20 });
  });
});
