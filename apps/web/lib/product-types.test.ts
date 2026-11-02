import { describe, expect, it } from 'vitest';
import type { ProductResponse, ProductTypeResponse } from '@potato-corner/shared';
import { BUILT_IN_PRODUCT_TYPES, parseProductTypeKey, productTypeCoversBranches, productTypeOptionsFor, productTypeRequestFields, productTypeSaveFields } from './product-types';

const CUSTOM_ID = 'b6f0a7de-5b0c-4e8b-9a43-0d2b7f3f1c11';

function custom(overrides: Partial<ProductTypeResponse> = {}): ProductTypeResponse {
  return {
    key: CUSTOM_ID,
    id: CUSTOM_ID,
    name: 'Marketing',
    description: null,
    is_builtin: false,
    is_active: true,
    version: 1,
    branches: [
      { branch_id: 'a', branch_name: 'A' },
      { branch_id: 'b', branch_name: 'B' },
    ],
    can_manage: true,
    product_count: 0,
    ...overrides,
  };
}

describe('product type helpers (POS-PERF-P58)', () => {
  it('accepts only something that could be a type in the URL', () => {
    expect(parseProductTypeKey('seasonal')).toBe('seasonal');
    expect(parseProductTypeKey(CUSTOM_ID)).toBe(CUSTOM_ID);
    expect(parseProductTypeKey('marketing')).toBeNull();
    expect(parseProductTypeKey("'><script>")).toBeNull();
    expect(parseProductTypeKey(null)).toBeNull();
  });

  it('a custom type must cover every branch; a built-in always does', () => {
    expect(productTypeCoversBranches(custom(), ['a', 'b'])).toBe(true);
    expect(productTypeCoversBranches(custom(), ['a', 'c'])).toBe(false);
    expect(productTypeCoversBranches(BUILT_IN_PRODUCT_TYPES[0] as ProductTypeResponse, ['a', 'c'])).toBe(true);
  });

  it('repeats only a built-in as classification, so an older API never reads a custom type as anything', () => {
    expect(productTypeRequestFields('promotional')).toEqual({ product_type: 'promotional', classification: 'promotional' });
    expect(productTypeRequestFields(CUSTOM_ID)).toEqual({ product_type: CUSTOM_ID });
  });

  it('an editor keeps the season window for Seasonal, clears it for other built-ins, and leaves it for custom types', () => {
    expect(productTypeSaveFields('seasonal', 'seasonal', '2026-12-01', '2026-12-31')).toMatchObject({ seasonal_start_date: '2026-12-01', seasonal_end_date: '2026-12-31' });
    expect(productTypeSaveFields('regular', 'seasonal', '2026-12-01', '2026-12-31')).toMatchObject({ seasonal_start_date: null, seasonal_end_date: null });
    expect(productTypeSaveFields(CUSTOM_ID, 'seasonal', '2026-12-01', '2026-12-31')).toEqual({ product_type: CUSTOM_ID });
    expect(productTypeSaveFields(CUSTOM_ID, CUSTOM_ID, undefined, undefined)).toEqual({});
  });

  it('offers only types valid at all of the product\'s branches, plus its current one', () => {
    const product = (key: string, active = true) =>
      ({ branches: [{ branch_id: 'a', branch_name: 'A', is_available: true }, { branch_id: 'c', branch_name: 'C', is_available: false }], product_type: { key, id: null, name: key, is_builtin: false, is_active: active } }) as unknown as ProductResponse;
    const types = [...BUILT_IN_PRODUCT_TYPES, custom()];
    expect(productTypeOptionsFor(product('regular'), types).map((o) => o.key)).toEqual(['regular', 'promotional', 'seasonal']);
    expect(productTypeOptionsFor(product(CUSTOM_ID, false), types).map((o) => o.key)).toEqual(['regular', 'promotional', 'seasonal', CUSTOM_ID]);
  });
});
