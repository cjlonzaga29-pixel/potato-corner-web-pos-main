import { describe, it, expect } from 'vitest';
import { cartItemSchema, createTransactionSchema } from './transaction.schema.js';

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
