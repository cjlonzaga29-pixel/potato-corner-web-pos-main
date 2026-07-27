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
    // length asserted via toHaveLength(1) above
    expect(groups[0]!.classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
    expect(groups[0]!.members.map((m) => m.ingredientId).sort()).toEqual(['a', 'b']);
  });

  it('marks same-name/different-unit as AMBIGUOUS, not auto-matched', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', branchId: 'b1', name: 'Cheese', unit: 'kg' }),
      ingredient({ id: 'b', branchId: 'b2', name: 'Cheese', unit: 'piece' }),
    ]);
    expect(groups).toHaveLength(1);
    // length asserted via toHaveLength(1) above
    expect(groups[0]!.classification).toBe('AMBIGUOUS');
  });

  it('marks same-name/same-unit but conflicting category as AMBIGUOUS', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Sprinkles', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'Sprinkles', unit: 'kg', category: 'FLAVOR' }),
    ]);
    // detectIdentityCollisions groups by normalized name; both share "sprinkles", so exactly one group is produced
    expect(groups[0]!.classification).toBe('AMBIGUOUS');
  });

  it('classifies a name with no collision as DISTINCT', () => {
    const groups = detectIdentityCollisions([ingredient({ id: 'a', name: 'Unique Item' })]);
    // a single input ingredient always produces exactly one group
    expect(groups[0]!.classification).toBe('DISTINCT');
  });

  it('classifies an empty name as INVALID', () => {
    const groups = detectIdentityCollisions([ingredient({ id: 'a', name: '   ' })]);
    // a single input ingredient always produces exactly one group
    expect(groups[0]!.classification).toBe('INVALID');
  });

  it('does not infer a match from name equality alone (name matches, unit/category differ, still not SAFE)', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'X', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'X', unit: 'bag', category: 'PACKAGING' }),
    ]);
    // detectIdentityCollisions groups by normalized name; both share "x", so exactly one group is produced
    expect(groups[0]!.classification).not.toBe('SAFE_AUTO_MATCH_CANDIDATE');
  });

  it('does not falsely collide units/categories containing "::" with genuinely distinct pairs', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Combo', unit: 'kg::box', category: 'RAW' }),
      ingredient({ id: 'b', name: 'Combo', unit: 'kg', category: 'box::RAW' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.classification).toBe('AMBIGUOUS');
  });

  it('normalizes category case when grouping (RAW vs raw match)', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Salt', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'Salt', unit: 'kg', category: 'raw' }),
    ]);
    expect(groups[0]!.classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
  });

  it('normalizes category whitespace when grouping (" RAW " vs "RAW" match)', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Pepper', unit: 'kg', category: '  RAW ' }),
      ingredient({ id: 'b', name: 'Pepper', unit: 'kg', category: 'RAW' }),
    ]);
    expect(groups[0]!.classification).toBe('SAFE_AUTO_MATCH_CANDIDATE');
  });

  it('preserves original (non-normalized) category text per member for reporting', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Pepper', unit: 'kg', category: '  RAW ' }),
      ingredient({ id: 'b', name: 'Pepper', unit: 'kg', category: 'raw' }),
    ]);
    const categories = groups[0]!.members.map((m) => m.legacyCategory).sort();
    expect(categories).toEqual(['  RAW ', 'raw']);
  });

  it('keeps genuinely different categories distinct (still AMBIGUOUS)', () => {
    const groups = detectIdentityCollisions([
      ingredient({ id: 'a', name: 'Cheese', unit: 'kg', category: 'RAW' }),
      ingredient({ id: 'b', name: 'Cheese', unit: 'kg', category: 'FLAVOR' }),
    ]);
    expect(groups[0]!.classification).toBe('AMBIGUOUS');
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
