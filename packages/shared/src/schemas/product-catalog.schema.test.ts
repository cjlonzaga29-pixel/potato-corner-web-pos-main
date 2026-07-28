import { describe, it, expect } from 'vitest';
import {
  createProductCategorySchema,
  createProductOptionGroupSchema,
  updateProductOptionGroupSchema,
  createProductOptionSchema,
} from './product-catalog.schema.js';

describe('createProductCategorySchema', () => {
  it('accepts a valid category', () => {
    const result = createProductCategorySchema.safeParse({ code: 'fries', name: 'Fries' });
    expect(result.success).toBe(true);
  });

  it('rejects an uppercase code', () => {
    const result = createProductCategorySchema.safeParse({ code: 'FRIES', name: 'Fries' });
    expect(result.success).toBe(false);
  });
});

describe('createProductOptionGroupSchema — SINGLE/MULTIPLE selection rules (R4)', () => {
  it('accepts a SINGLE group with max_selections 1', () => {
    const result = createProductOptionGroupSchema.safeParse({
      code: 'flavor',
      name: 'Flavor',
      selection_type: 'SINGLE',
      min_selections: 1,
      max_selections: 1,
      required: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a SINGLE group with max_selections greater than 1', () => {
    const result = createProductOptionGroupSchema.safeParse({
      code: 'flavor',
      name: 'Flavor',
      selection_type: 'SINGLE',
      min_selections: 0,
      max_selections: 2,
      required: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a MULTIPLE group with max_selections greater than 1', () => {
    const result = createProductOptionGroupSchema.safeParse({
      code: 'toppings',
      name: 'Toppings',
      selection_type: 'MULTIPLE',
      min_selections: 0,
      max_selections: 3,
      required: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects min_selections greater than max_selections', () => {
    const result = createProductOptionGroupSchema.safeParse({
      code: 'toppings',
      name: 'Toppings',
      selection_type: 'MULTIPLE',
      min_selections: 5,
      max_selections: 3,
      required: false,
    });
    expect(result.success).toBe(false);
  });

  it('update schema rejects the same SINGLE/max_selections conflict', () => {
    const result = updateProductOptionGroupSchema.safeParse({ selection_type: 'SINGLE', max_selections: 4 });
    expect(result.success).toBe(false);
  });
});

describe('createProductOptionSchema', () => {
  it('accepts an option with a negative price_adjustment (discount)', () => {
    const result = createProductOptionSchema.safeParse({ code: 'no-cheese', name: 'No Cheese', price_adjustment: -5, is_active: true });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid code format', () => {
    const result = createProductOptionSchema.safeParse({ code: 'No Cheese!', name: 'No Cheese', is_active: true });
    expect(result.success).toBe(false);
  });
});
