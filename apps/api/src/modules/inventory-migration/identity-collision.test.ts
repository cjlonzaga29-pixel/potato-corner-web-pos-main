import { describe, it, expect } from 'vitest';
import { detectIdentityCollisions, detectSkuCollisions, detectBarcodeCollisions } from './identity-collision.js';
import type { LegacyIngredientRecord } from './types.js';

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return {
    id: 'ing-1', name: 'Cheese Powder', unit: 'kg', category: 'RAW', branchId: 'branch-1', deletedAt: null,
    ...overrides,
  };
}

describe('detectIdentityCollisions', () => {
  it('groups same-name/same-unit/same-category across branches as SAFE_AUTO_MATCH_CANDIDATE', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', branchId: 'b1', name: 'Cheese Powder', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', branchId: 'b2', name: 'CHEESE   POWDER', unit: 'KG', category: 'RAW' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
    expect(groups[0].members.map((m) => m.ingredientId).sort()).toEqual(['a', 'b']);
  });

  it('marks same-name/different-unit as AMBIGUOUS, not auto-matched', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', branchId: 'b1', name: 'Cheese', unit: 'kg' }),
      ingredient({ id: 'b', branchId: 'b2', name: 'Cheese', unit: 'piece' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].classification).toBe('AMBIGUOUS');
  });

  it('marks same-name/same-unit but conflicting category as AMBIGUOUS', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Sprinkles', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'Sprinkles', unit: 'kg', category: 'FLAVOR' }),
    ]);
    expect(groups[0].classification).toBe('AMBIGUOUS');
  });

  it('classifies a name with no collision as DISTINCT', () => {
    const groups = detectIdentityCollisions([ingredient({ id: 'a', name: 'Unique Item' })]);
    expect(groups[0].classification).toBe('DISTINCT');
  });

  it('classifies an empty name as INVALID', () => {
    const groups = detectIdentityCollisions([ingredient({ id: 'a', name: '   ' })]);
    expect(groups[0].classification).toBe('INVALID');
  });

  it('does not infer a match from name equality alone (name matches, unit/category differ, still not SAFE)', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'X', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'X', unit: 'bag', category: 'PACKAGING' }),
    ]);
    expect(groups[0].classification).not.toBe('SAFE_AUTO_MATCH_CANDIDATE');
  });

  it('excludes soft-deleted ingredients from grouping', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Gone', deletedAt: new Date() }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe('detectSkuCollisions / detectBarcodeCollisions', () => {
  it('return empty arrays because legacy Ingredient has no sku/barcode columns', () => {
    expect(detectSkuCollisions()).toEqual([]);
    expect(detectBarcodeCollisions()).toEqual([]);
  });
});
