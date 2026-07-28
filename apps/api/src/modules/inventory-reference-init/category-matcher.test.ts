import { describe, it, expect } from 'vitest';
import { matchCategory } from './category-matcher.js';
import type { ManifestCategoryEntry } from './types.js';

function entry(overrides: Partial<ManifestCategoryEntry> = {}): ManifestCategoryEntry {
  return {
    code: 'FLAVORING', name: 'Flavoring', description: null, isActive: true,
    source: 'OPERATOR_APPROVED', evidence: 'test', approvalStatus: 'APPROVED', ...overrides,
  };
}

describe('matchCategory', () => {
  it('WILL_CREATE when no existing row matches', () => {
    expect(matchCategory(entry(), [])).toEqual({ status: 'WILL_CREATE' });
  });

  it('WILL_REUSE on exact normalized-name fold', () => {
    const result = matchCategory(entry({ name: ' Flavoring ' }), [{ id: 'cat-1', name: 'flavoring', code: null, description: null }]);
    expect(result).toEqual({ status: 'WILL_REUSE', existingId: 'cat-1' });
  });

  it('BLOCKED_AMBIGUOUS when two existing rows fold to the same name', () => {
    const result = matchCategory(entry(), [
      { id: 'cat-1', name: 'Flavoring', code: null, description: null },
      { id: 'cat-2', name: 'flavoring', code: null, description: null },
    ]);
    expect(result.status).toBe('BLOCKED_AMBIGUOUS');
    expect((result as { matchedIds: string[] }).matchedIds).toEqual(['cat-1', 'cat-2']);
  });

  it('BLOCKED_INCOMPATIBLE when both sides have a non-null code that disagrees', () => {
    const result = matchCategory(entry({ code: 'FLAVORING' }), [{ id: 'cat-1', name: 'Flavoring', code: 'FLV', description: null }]);
    expect(result.status).toBe('BLOCKED_INCOMPATIBLE');
  });

  it('WILL_REUSE (not blocked) when the existing row has a null code', () => {
    const result = matchCategory(entry(), [{ id: 'cat-1', name: 'Flavoring', code: null, description: null }]);
    expect(result).toEqual({ status: 'WILL_REUSE', existingId: 'cat-1' });
  });

  it('description drift alone is never blocking', () => {
    const result = matchCategory(entry(), [{ id: 'cat-1', name: 'Flavoring', code: null, description: 'a totally different description' }]);
    expect(result.status).toBe('WILL_REUSE');
  });
});
