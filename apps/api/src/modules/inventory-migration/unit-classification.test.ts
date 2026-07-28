import { describe, it, expect } from 'vitest';
import { classifyLegacyUnits } from './unit-classification.js';
import type { LegacyIngredientRecord } from './types.js';

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return {
    id: 'ing-1', name: 'Test', unit: 'kg', category: 'RAW', branchId: 'branch-1', deletedAt: null,
    ...overrides,
  };
}

/** First element of an array asserted non-empty (avoids `!` under noUncheckedIndexedAccess). */
function firstOf<T>(arr: readonly T[]): T {
  const [head] = arr;
  if (head === undefined) throw new Error('expected a non-empty array');
  return head;
}

describe('classifyLegacyUnits', () => {
  it('classifies a unit matching an existing UnitOfMeasure code as EXACT_GLOBAL_UNIT', () => {
    const result = classifyLegacyUnits(
      [ingredient({ id: 'a', unit: 'kg' })],
      [{ code: 'KG' }],
    );
    expect(result).toHaveLength(1);
    // length asserted via toHaveLength(1) above
    expect(firstOf(result).classification).toBe('EXACT_GLOBAL_UNIT');
    expect(firstOf(result).affectedIngredientIds).toEqual(['a']);
  });

  it('classifies known synonyms as NORMALIZABLE_GLOBAL_UNIT without an existing UnitOfMeasure row', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'gram' })], []);
    // a single input ingredient always produces exactly one classification entry
    expect(firstOf(result).classification).toBe('NORMALIZABLE_GLOBAL_UNIT');
    expect(firstOf(result).proposedCanonicalUnitName).toBe('gram');
  });

  it('classifies kg as NORMALIZABLE_GLOBAL_UNIT with advisory canonical name only (no UnitOfMeasure.code/id implied)', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'kg' })], []);
    expect(firstOf(result).classification).toBe('NORMALIZABLE_GLOBAL_UNIT');
    expect(firstOf(result).proposedCanonicalUnitName).toBe('kilogram');
  });

  it('classifies box as ITEM_SPECIFIC_PACKAGE_UNIT with no proposed canonical unit name', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'box' })], []);
    expect(firstOf(result).classification).toBe('ITEM_SPECIFIC_PACKAGE_UNIT');
    expect(firstOf(result).proposedCanonicalUnitName).toBeNull();
  });

  it('classifies an unknown unit with no proposed canonical unit name', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'blorp' })], []);
    expect(firstOf(result).classification).toBe('UNKNOWN');
    expect(firstOf(result).proposedCanonicalUnitName).toBeNull();
  });

  it('classifies package-style units as ITEM_SPECIFIC_PACKAGE_UNIT with a blocking reason', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'box' })], []);
    // a single input ingredient always produces exactly one classification entry
    expect(firstOf(result).classification).toBe('ITEM_SPECIFIC_PACKAGE_UNIT');
    expect(firstOf(result).blockingReason).not.toBeNull();
  });

  it('classifies unrecognized units as UNKNOWN', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: 'blorp' })], []);
    // a single input ingredient always produces exactly one classification entry
    expect(firstOf(result).classification).toBe('UNKNOWN');
  });

  it('classifies empty/whitespace units as INVALID', () => {
    const result = classifyLegacyUnits([ingredient({ id: 'a', unit: '   ' })], []);
    // a single input ingredient always produces exactly one classification entry
    expect(firstOf(result).classification).toBe('INVALID');
  });

  it('preserves distinct units as separate entries (does not merge kg and bag)', () => {
    const result = classifyLegacyUnits(
      [ingredient({ id: 'a', unit: 'kg' }), ingredient({ id: 'b', unit: 'bag' })],
      [{ code: 'KG' }],
    );
    expect(result).toHaveLength(2);
    const kgEntry = result.find((r) => r.normalizedUnit === 'kg');
    const bagEntry = result.find((r) => r.normalizedUnit === 'bag');
    expect(kgEntry?.classification).toBe('EXACT_GLOBAL_UNIT');
    expect(bagEntry?.classification).toBe('ITEM_SPECIFIC_PACKAGE_UNIT');
  });

  it('groups identical normalized units and aggregates occurrence counts', () => {
    const result = classifyLegacyUnits(
      [ingredient({ id: 'a', unit: 'KG' }), ingredient({ id: 'b', unit: ' kg ' })],
      [],
    );
    expect(result).toHaveLength(1);
    // length asserted via toHaveLength(1) above
    expect(firstOf(result).occurrenceCount).toBe(2);
    expect(firstOf(result).affectedIngredientIds.sort()).toEqual(['a', 'b']);
  });
});
