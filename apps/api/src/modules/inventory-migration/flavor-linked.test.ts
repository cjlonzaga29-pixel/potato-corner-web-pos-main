import { describe, it, expect } from 'vitest';
import { detectFlavorLinkedCandidates } from './flavor-linked.js';
import type { LegacyFlavorRecord, LegacyIngredientRecord } from './types.js';

function flavor(overrides: Partial<LegacyFlavorRecord>): LegacyFlavorRecord {
  return { id: 'flavor-1', name: 'Cheese', ingredientName: 'Cheese Powder', ingredientUnit: 'kg', isActive: true, ...overrides };
}

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return { id: 'ing-1', name: 'Cheese Powder', unit: 'kg', category: 'FLAVOR', branchId: 'b1', deletedAt: null, ...overrides };
}

/** First element of an array asserted non-empty (avoids `!` under noUncheckedIndexedAccess). */
function firstOf<T>(arr: readonly T[]): T {
  const [head] = arr;
  if (head === undefined) throw new Error('expected a non-empty array');
  return head;
}

describe('detectFlavorLinkedCandidates', () => {
  it('matches a flavor to ingredients by normalized name+unit across branches', () => {
    const result = detectFlavorLinkedCandidates(
      [flavor({})],
      [
        ingredient({ id: 'a', branchId: 'b1', name: 'CHEESE   POWDER', unit: 'KG' }),
        ingredient({ id: 'b', branchId: 'b2', name: 'cheese powder', unit: 'kg' }),
      ],
    );
    expect(result).toHaveLength(1);
    // length asserted via toHaveLength(1) above
    expect(firstOf(result).matchedIngredientIds.sort()).toEqual(['a', 'b']);
    expect(firstOf(result).mappingMethod).toBe('FLAVOR_IDENTITY');
    expect(firstOf(result).unresolved).toBe(false);
  });

  it('marks a flavor unresolved when no matching legacy ingredient exists', () => {
    const result = detectFlavorLinkedCandidates([flavor({ ingredientName: 'Nonexistent', ingredientUnit: 'kg' })], []);
    // detectFlavorLinkedCandidates maps 1:1 over the flavors array; exactly one flavor was passed in, so result[0] exists
    expect(firstOf(result).unresolved).toBe(true);
    expect(firstOf(result).matchedIngredientIds).toEqual([]);
  });

  it('excludes soft-deleted ingredients from matching', () => {
    const result = detectFlavorLinkedCandidates(
      [flavor({})],
      [ingredient({ id: 'a', deletedAt: new Date() })],
    );
    // detectFlavorLinkedCandidates maps 1:1 over the flavors array; exactly one flavor was passed in, so result[0] exists
    expect(firstOf(result).unresolved).toBe(true);
  });

  it('does not match on unit alone if name differs', () => {
    const result = detectFlavorLinkedCandidates(
      [flavor({ ingredientName: 'Cheese Powder', ingredientUnit: 'kg' })],
      [ingredient({ id: 'a', name: 'Chocolate Powder', unit: 'kg' })],
    );
    // detectFlavorLinkedCandidates maps 1:1 over the flavors array; exactly one flavor was passed in, so result[0] exists
    expect(firstOf(result).matchedIngredientIds).toEqual([]);
  });
});
