import { describe, it, expect } from 'vitest';
import { classifyLegacyCategories } from './category-classification.js';
import type { LegacyIngredientRecord } from './types.js';

function ingredient(overrides: Partial<LegacyIngredientRecord>): LegacyIngredientRecord {
  return {
    id: 'ing-1', name: 'Test', unit: 'kg', category: 'RAW', branchId: 'branch-1', deletedAt: null,
    ...overrides,
  };
}

describe('classifyLegacyCategories', () => {
  it('maps known legacy categories to proposed candidate names with counts', () => {
    const result = classifyLegacyCategories([
      ingredient({ id: 'a', category: 'RAW' }),
      ingredient({ id: 'b', category: 'RAW' }),
      ingredient({ id: 'c', category: 'PACKAGING' }),
    ]);

    const raw = result.find((r) => r.legacyCategory === 'RAW');
    const packaging = result.find((r) => r.legacyCategory === 'PACKAGING');
    expect(raw).toMatchObject({ proposedCategoryName: 'Raw Material', affectedIngredientCount: 2, confidence: 'HIGH' });
    expect(packaging).toMatchObject({ proposedCategoryName: 'Packaging', affectedIngredientCount: 1 });
  });

  it('marks OTHER as low confidence and unresolved', () => {
    const result = classifyLegacyCategories([ingredient({ id: 'a', category: 'OTHER' })]);
    expect(result[0]).toMatchObject({ confidence: 'LOW', unresolved: true });
  });

  it('does not hardcode a fixed enum — unmapped categories still produce a candidate', () => {
    const result = classifyLegacyCategories([ingredient({ id: 'a', category: 'SOME_FUTURE_VALUE' })]);
    expect(result[0]).toMatchObject({ legacyCategory: 'SOME_FUTURE_VALUE', unresolved: true, confidence: 'LOW' });
  });
});
