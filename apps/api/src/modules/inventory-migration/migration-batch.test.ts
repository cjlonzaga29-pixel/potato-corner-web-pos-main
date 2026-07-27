import { describe, it, expect } from 'vitest';
import {
  generateMigrationBatchId,
  formatMigrationBatchId,
  isValidMigrationBatchId,
} from './migration-batch.js';

describe('formatMigrationBatchId', () => {
  it('formats as CR006-INGREDIENT-YYYYMMDD-HHMMSS in UTC', () => {
    const date = new Date(Date.UTC(2026, 6, 27, 12, 5, 9));
    expect(formatMigrationBatchId(date)).toBe('CR006-INGREDIENT-20260727-120509');
  });
});

describe('generateMigrationBatchId', () => {
  it('defaults to the current time and is reproducible for a given Date', () => {
    const date = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));
    expect(generateMigrationBatchId(date)).toBe('CR006-INGREDIENT-20250101-000000');
  });
});

describe('isValidMigrationBatchId', () => {
  it('accepts well-formed batch IDs', () => {
    expect(isValidMigrationBatchId('CR006-INGREDIENT-20260727-120509')).toBe(true);
  });

  it('rejects malformed batch IDs', () => {
    expect(isValidMigrationBatchId('not-a-batch-id')).toBe(false);
    expect(isValidMigrationBatchId('CR006-INGREDIENT-2026-07-27')).toBe(false);
  });
});
