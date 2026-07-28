import { describe, it, expect } from 'vitest';
import { matchUnit } from './unit-matcher.js';
import type { ManifestUnitEntry } from './types.js';

function entry(overrides: Partial<ManifestUnitEntry> = {}): ManifestUnitEntry {
  return {
    code: 'g', name: 'Gram', symbol: 'g', dimension: 'WEIGHT', isBaseUnit: true, isActive: true,
    source: 'OPERATOR_APPROVED', evidence: 'test', approvalStatus: 'APPROVED', ...overrides,
  };
}

describe('matchUnit', () => {
  it('WILL_CREATE when no existing row matches', () => {
    expect(matchUnit(entry(), [])).toEqual({ status: 'WILL_CREATE' });
  });

  it('WILL_REUSE on exact code match with matching dimension', () => {
    const result = matchUnit(entry(), [{ id: 'unit-1', code: 'g', name: 'Gram', dimension: 'WEIGHT' }]);
    expect(result).toEqual({ status: 'WILL_REUSE', existingId: 'unit-1' });
  });

  it('BLOCKED_INCOMPATIBLE when code matches but dimension differs', () => {
    const result = matchUnit(entry(), [{ id: 'unit-1', code: 'g', name: 'Gram', dimension: 'VOLUME' }]);
    expect(result.status).toBe('BLOCKED_INCOMPATIBLE');
  });

  it('BLOCKED_AMBIGUOUS when no code match but name folds identically to an existing row', () => {
    const result = matchUnit(entry({ code: 'gram-alt' }), [{ id: 'unit-1', code: 'g', name: 'Gram', dimension: 'WEIGHT' }]);
    expect(result.status).toBe('BLOCKED_AMBIGUOUS');
  });

  it('identity is code, never name alone: different code + different name never collides with an unrelated unit', () => {
    const result = matchUnit(entry({ code: 'kg', name: 'Kilogram' }), [{ id: 'unit-1', code: 'g', name: 'Gram', dimension: 'WEIGHT' }]);
    expect(result).toEqual({ status: 'WILL_CREATE' });
  });
});
