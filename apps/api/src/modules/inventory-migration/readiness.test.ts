import { describe, it, expect } from 'vitest';
import { evaluateReadiness } from './readiness.js';
import type { ReadinessInput } from './readiness.js';

function baseInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    normalizedUnits: [],
    ambiguousGroups: [],
    skuCollisions: [],
    barcodeCollisions: [],
    flavorLinkedCandidates: [],
    invalidRecords: [],
    ...overrides,
  };
}

describe('evaluateReadiness', () => {
  it('is ready with no blockers when everything is clean', () => {
    const result = evaluateReadiness(baseInput());
    expect(result.migrationReadiness).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('blocks on unresolved SKU collisions', () => {
    const result = evaluateReadiness(baseInput({ skuCollisions: [{ sku: 'X', ingredientIds: ['a', 'b'] }] }));
    expect(result.migrationReadiness).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('blocks on unresolved barcode collisions', () => {
    const result = evaluateReadiness(baseInput({ barcodeCollisions: [{ barcode: 'Y', ingredientIds: ['a', 'b'] }] }));
    expect(result.migrationReadiness).toBe(false);
  });

  it('blocks on unresolved invalid records', () => {
    const result = evaluateReadiness(baseInput({ invalidRecords: [{ ingredientId: 'a', reason: 'Empty name' }] }));
    expect(result.migrationReadiness).toBe(false);
  });

  it('does not block on ambiguous groups — they are a warning only', () => {
    const result = evaluateReadiness(
      baseInput({
        ambiguousGroups: [{ normalizedName: 'x', classification: 'AMBIGUOUS', members: [], reason: 'r' }],
      }),
    );
    expect(result.migrationReadiness).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not block on UNKNOWN units — warning only', () => {
    const result = evaluateReadiness(
      baseInput({
        normalizedUnits: [
          { rawUnit: 'x', normalizedUnit: 'x', occurrenceCount: 1, affectedIngredientIds: ['a'], proposedUnitOfMeasureCode: null, classification: 'UNKNOWN', blockingReason: 'r' },
        ],
      }),
    );
    expect(result.migrationReadiness).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
