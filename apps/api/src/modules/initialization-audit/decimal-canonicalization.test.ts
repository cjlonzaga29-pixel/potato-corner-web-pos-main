import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { canonicalizeDecimal } from './decimal-canonicalization.js';

describe('canonicalizeDecimal', () => {
  it('produces the six worked examples byte-exact (string input)', () => {
    expect(canonicalizeDecimal('1000')).toBe('1000');
    expect(canonicalizeDecimal('1000.0')).toBe('1000');
    expect(canonicalizeDecimal('1000.000000')).toBe('1000');
    expect(canonicalizeDecimal('0.001000')).toBe('0.001');
    expect(canonicalizeDecimal('-0.000')).toBe('0');
    expect(canonicalizeDecimal('1.2300400')).toBe('1.23004');
  });

  it('keeps 1 and 1.0001 distinct', () => {
    expect(canonicalizeDecimal('1')).toBe('1');
    expect(canonicalizeDecimal('1.0001')).toBe('1.0001');
    expect(canonicalizeDecimal('1')).not.toBe(canonicalizeDecimal('1.0001'));
  });

  it('normalizes negative zero variants to "0"', () => {
    expect(canonicalizeDecimal('-0')).toBe('0');
    expect(canonicalizeDecimal('-0.000')).toBe('0');
    expect(canonicalizeDecimal('0.000')).toBe('0');
  });

  it('rejects scientific-notation manifest input instead of expanding it', () => {
    expect(() => canonicalizeDecimal('1e3')).toThrow();
    expect(() => canonicalizeDecimal('1E3')).toThrow();
    expect(() => canonicalizeDecimal('1.5e-2')).toThrow();
  });

  it('rejects invalid decimal strings', () => {
    expect(() => canonicalizeDecimal('abc')).toThrow();
    expect(() => canonicalizeDecimal('')).toThrow();
    expect(() => canonicalizeDecimal('12.34.56')).toThrow();
    expect(() => canonicalizeDecimal('1,000')).toThrow();
  });

  it('rejects NaN and Infinity Decimal instances', () => {
    expect(() => canonicalizeDecimal(new Prisma.Decimal(NaN))).toThrow();
    expect(() => canonicalizeDecimal(new Prisma.Decimal(Infinity))).toThrow();
  });

  it('preserves full precision for a 30+ significant digit value with no Number round-trip', () => {
    const huge = '123456789012345678901234567890.123456789012345';
    expect(canonicalizeDecimal(huge)).toBe(huge);

    // Sanity: this value cannot survive a round-trip through JS Number without
    // losing precision, which is exactly what canonicalizeDecimal must avoid.
    expect(Number(huge).toString()).not.toBe(huge);
  });

  it('gives identical results for a manifest string and an equivalent Prisma.Decimal instance', () => {
    const fromString = canonicalizeDecimal('1000.000');
    const fromDecimal = canonicalizeDecimal(new Prisma.Decimal(1000));
    expect(fromString).toBe(fromDecimal);
    expect(fromString).toBe('1000');
  });
});
