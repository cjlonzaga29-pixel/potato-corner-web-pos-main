import { describe, it, expect } from 'vitest';
import { generateReferenceInitBatchId, isValidReferenceInitBatchId } from './batch-id.js';

describe('generateReferenceInitBatchId / isValidReferenceInitBatchId', () => {
  it('generates a batch id matching its own validator', () => {
    const id = generateReferenceInitBatchId(new Date('2026-07-28T12:34:56Z'));
    expect(id).toBe('PHASEC0-REFINIT-20260728-123456');
    expect(isValidReferenceInitBatchId(id)).toBe(true);
  });

  it('rejects malformed batch ids', () => {
    expect(isValidReferenceInitBatchId('not-a-batch-id')).toBe(false);
    expect(isValidReferenceInitBatchId('CR006-INGREDIENT-20260728-123456')).toBe(false);
  });
});
