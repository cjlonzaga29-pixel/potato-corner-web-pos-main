import { describe, it, expect } from 'vitest';
import { matchConversion } from './conversion-matcher.js';
import type { ManifestConversionEntry } from './types.js';

function entry(overrides: Partial<ManifestConversionEntry> = {}): ManifestConversionEntry {
  return {
    fromUnitCode: 'kg', toUnitCode: 'g', factor: '1000',
    source: 'ARCHITECTURE_REQUIRED', evidence: 'test', approvalStatus: 'APPROVED', ...overrides,
  };
}

describe('matchConversion', () => {
  it('MISSING_DEPENDENCY when fromUnitCode is not yet resolved', () => {
    const result = matchConversion(entry(), new Map([['g', 'unit-g']]), []);
    expect(result.status).toBe('MISSING_DEPENDENCY');
  });

  it('MISSING_DEPENDENCY when toUnitCode is not yet resolved', () => {
    const result = matchConversion(entry(), new Map([['kg', 'unit-kg']]), []);
    expect(result.status).toBe('MISSING_DEPENDENCY');
  });

  it('WILL_CREATE when both units resolve and no existing conversion row exists', () => {
    const result = matchConversion(entry(), new Map([['kg', 'unit-kg'], ['g', 'unit-g']]), []);
    expect(result).toEqual({ status: 'WILL_CREATE', fromUnitId: 'unit-kg', toUnitId: 'unit-g' });
  });

  it('WILL_REUSE when an exact (fromUnitId, toUnitId) pair exists with an equivalent factor', () => {
    const resolved = new Map([['kg', 'unit-kg'], ['g', 'unit-g']]);
    const result = matchConversion(entry({ factor: '1000.000' }), resolved, [
      { id: 'conv-1', fromUnitId: 'unit-kg', toUnitId: 'unit-g', factor: '1000' },
    ]);
    expect(result).toEqual({ status: 'WILL_REUSE', existingId: 'conv-1', fromUnitId: 'unit-kg', toUnitId: 'unit-g' });
  });

  it('BLOCKED_INCOMPATIBLE when the pair exists with a disagreeing factor', () => {
    const resolved = new Map([['kg', 'unit-kg'], ['g', 'unit-g']]);
    const result = matchConversion(entry({ factor: '999' }), resolved, [
      { id: 'conv-1', fromUnitId: 'unit-kg', toUnitId: 'unit-g', factor: '1000' },
    ]);
    expect(result.status).toBe('BLOCKED_INCOMPATIBLE');
  });

  it('direction is significant: kg->g never matches an existing g->kg row', () => {
    const resolved = new Map([['kg', 'unit-kg'], ['g', 'unit-g']]);
    const result = matchConversion(entry({ fromUnitCode: 'kg', toUnitCode: 'g' }), resolved, [
      { id: 'conv-1', fromUnitId: 'unit-g', toUnitId: 'unit-kg', factor: '0.001' },
    ]);
    expect(result.status).toBe('WILL_CREATE');
  });
});
