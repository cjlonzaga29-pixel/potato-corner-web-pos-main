import { describe, it, expect } from 'vitest';
import {
  normalizeInventoryName,
  normalizeLegacyUnit,
  normalizeSku,
  normalizeBarcode,
} from './normalization.js';

describe('normalizeInventoryName', () => {
  it('trims, collapses internal whitespace, and lowercases', () => {
    expect(normalizeInventoryName(' Cheese Powder ')).toEqual({
      raw: ' Cheese Powder ',
      normalized: 'cheese powder',
    });
    expect(normalizeInventoryName('CHEESE   POWDER')).toEqual({
      raw: 'CHEESE   POWDER',
      normalized: 'cheese powder',
    });
    expect(normalizeInventoryName('cheese powder')).toEqual({
      raw: 'cheese powder',
      normalized: 'cheese powder',
    });
  });

  it('does not conflate distinct business terms', () => {
    expect(normalizeInventoryName('cheese').normalized).not.toBe(
      normalizeInventoryName('cheese powder').normalized,
    );
  });

  it('preserves the raw value separately from normalized', () => {
    const result = normalizeInventoryName('  Sour Cream  ');
    expect(result.raw).toBe('  Sour Cream  ');
    expect(result.normalized).toBe('sour cream');
  });
});

describe('normalizeLegacyUnit', () => {
  it('trims, collapses whitespace, and lowercases', () => {
    expect(normalizeLegacyUnit(' KG ')).toEqual({ raw: ' KG ', normalized: 'kg' });
  });

  it('does not equate distinct units', () => {
    expect(normalizeLegacyUnit('kg').normalized).not.toBe(normalizeLegacyUnit('bag').normalized);
    expect(normalizeLegacyUnit('piece').normalized).not.toBe(normalizeLegacyUnit('box').normalized);
  });
});

describe('normalizeSku / normalizeBarcode', () => {
  it('returns null for null input', () => {
    expect(normalizeSku(null)).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
  });

  it('trims, collapses whitespace, and uppercases', () => {
    expect(normalizeSku(' sku-001 ')).toEqual({ raw: ' sku-001 ', normalized: 'SKU-001' });
    expect(normalizeBarcode(' abc  123 ')).toEqual({ raw: ' abc  123 ', normalized: 'ABC 123' });
  });
});
