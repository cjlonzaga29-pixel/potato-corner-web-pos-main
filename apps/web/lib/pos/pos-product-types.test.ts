import { describe, it, expect } from 'vitest';
import type { PosCatalogProductType } from '@potato-corner/shared';
import { ALL_PRODUCT_TYPES, buildPosTypeTabs, effectiveTypeFilter, posTypeFilterKey, productMatchesTypeFilter, readCachedProductTypes } from './pos-product-types';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const regular: PosCatalogProductType = { key: 'regular', id: null, name: 'Regular', is_builtin: true, is_active: true };
const custom = (id: string, name: string, isActive = true): PosCatalogProductType => ({ key: id, id, name, is_builtin: false, is_active: isActive });

describe('POS-PERF-P69 pos-product-types', () => {
  it('keeps built-in keys and custom ids in separate namespaces', () => {
    expect(posTypeFilterKey(regular)).toBe('builtin:regular');
    expect(posTypeFilterKey(custom(ID_A, 'Marketing'))).toBe(`custom:${ID_A}`);
    // A custom type literally named "Regular" still cannot collide with the built-in.
    expect(posTypeFilterKey(custom(ID_A, 'Regular'))).not.toBe(posTypeFilterKey(regular));
  });

  it('builds tabs from the server list, skipping inactive and duplicate entries; null without a list', () => {
    expect(buildPosTypeTabs(undefined)).toBeNull();
    expect(buildPosTypeTabs([regular, custom(ID_A, 'Marketing'), custom(ID_A, 'Marketing'), custom(ID_B, 'Old', false)])).toEqual([
      { filterKey: 'builtin:regular', name: 'Regular' },
      { filterKey: `custom:${ID_A}`, name: 'Marketing' },
    ]);
  });

  it('two same-named custom types stay two tabs', () => {
    expect(buildPosTypeTabs([custom(ID_A, 'Marketing'), custom(ID_B, 'Marketing')])).toHaveLength(2);
  });

  it('matches only the displayed type; a product without type data matches only All Types', () => {
    const marketingProduct = { product_type: custom(ID_A, 'Marketing') };
    expect(productMatchesTypeFilter(marketingProduct, `custom:${ID_A}`)).toBe(true);
    expect(productMatchesTypeFilter(marketingProduct, 'builtin:regular')).toBe(false);
    expect(productMatchesTypeFilter({ product_type: undefined }, 'builtin:regular')).toBe(false);
    expect(productMatchesTypeFilter({ product_type: null }, ALL_PRODUCT_TYPES)).toBe(true);
  });

  it('falls back to All Types for a vanished selection or a hidden filter', () => {
    const tabs = buildPosTypeTabs([regular]);
    expect(effectiveTypeFilter('builtin:regular', tabs)).toBe('builtin:regular');
    expect(effectiveTypeFilter(`custom:${ID_A}`, tabs)).toBe(ALL_PRODUCT_TYPES);
    expect(effectiveTypeFilter('builtin:regular', null)).toBe(ALL_PRODUCT_TYPES);
  });

  it('reads the cached type list, and treats pre-P69 or malformed rows as no list', () => {
    expect(readCachedProductTypes([])).toBeUndefined();
    expect(readCachedProductTypes([{}])).toBeUndefined();
    expect(readCachedProductTypes([{ productTypes: [{ nope: true }] }])).toBeUndefined();
    expect(readCachedProductTypes([{ productTypes: [regular] }])).toEqual([regular]);
  });
});
