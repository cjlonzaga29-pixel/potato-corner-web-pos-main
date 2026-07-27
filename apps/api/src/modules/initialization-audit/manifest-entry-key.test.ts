import { describe, it, expect } from 'vitest';
import {
  normalizeNaturalKeySegment,
  buildInventoryCategoryKey,
  buildUnitOfMeasureKey,
  buildUnitConversionKey,
  validateManifestNoDuplicateKeys,
} from './manifest-entry-key.js';

describe('normalizeNaturalKeySegment', () => {
  it('trims leading/trailing whitespace and lowercases', () => {
    expect(normalizeNaturalKeySegment(' Flavor ')).toBe('flavor');
    expect(normalizeNaturalKeySegment('G')).toBe('g');
  });

  it('lowercases using locale-independent .toLowerCase() semantics', () => {
    // The Turkish-locale "I" -> "i-with-no-dot" quirk only shows up with
    // toLocaleLowerCase under a tr locale; this asserts the ordinary,
    // locale-independent result instead.
    expect(normalizeNaturalKeySegment('I')).toBe('i');
  });

  it('preserves internal spaces and does not collapse them', () => {
    expect(normalizeNaturalKeySegment('sour  cream')).toBe('sour  cream');
  });

  it('normalizes Unicode NFC-equivalent forms to the same value', () => {
    const precomposed = 'é'; // e-acute, single code point
    const decomposed = 'é'; // "e" + combining acute accent
    expect(normalizeNaturalKeySegment(precomposed)).toBe(
      normalizeNaturalKeySegment(decomposed),
    );
  });

  it('rejects empty normalized values', () => {
    expect(() => normalizeNaturalKeySegment('')).toThrow();
    expect(() => normalizeNaturalKeySegment('   ')).toThrow();
  });

  it('rejects ASCII control characters (U+0000-U+001F and U+007F)', () => {
    expect(() => normalizeNaturalKeySegment(`fla${String.fromCharCode(0x00)}vor`)).toThrow();
    expect(() => normalizeNaturalKeySegment(`fla${String.fromCharCode(0x1f)}vor`)).toThrow();
    expect(() => normalizeNaturalKeySegment(`fla${String.fromCharCode(0x7f)}vor`)).toThrow();
    expect(() => normalizeNaturalKeySegment(`fla${String.fromCharCode(0x09)}vor`)).toThrow(); // tab
  });

  it('rejects the reserved ":" character', () => {
    expect(() => normalizeNaturalKeySegment('flavor:special')).toThrow();
  });

  it('rejects the reserved "->" sequence', () => {
    expect(() => normalizeNaturalKeySegment('kg->g')).toThrow();
  });

  it('throws when given a non-string at runtime', () => {
    expect(() => normalizeNaturalKeySegment(123 as unknown as string)).toThrow();
  });
});

describe('buildInventoryCategoryKey', () => {
  it('produces the same key for " Flavor " and "flavor"', () => {
    expect(buildInventoryCategoryKey(' Flavor ')).toBe(
      buildInventoryCategoryKey('flavor'),
    );
  });

  it('uses the locked INVENTORY_CATEGORY: prefix format', () => {
    expect(buildInventoryCategoryKey('flavor')).toBe('INVENTORY_CATEGORY:flavor');
  });
});

describe('buildUnitOfMeasureKey', () => {
  it('produces the same key for "G" and "g"', () => {
    expect(buildUnitOfMeasureKey('G')).toBe(buildUnitOfMeasureKey('g'));
  });

  it('uses the locked UNIT_OF_MEASURE: prefix format', () => {
    expect(buildUnitOfMeasureKey('g')).toBe('UNIT_OF_MEASURE:g');
  });
});

describe('buildUnitConversionKey', () => {
  it('is directed: kg->g differs from g->kg', () => {
    expect(buildUnitConversionKey('kg', 'g')).not.toBe(
      buildUnitConversionKey('g', 'kg'),
    );
  });

  it('uses the locked UNIT_CONVERSION:<from>-><to> format', () => {
    expect(buildUnitConversionKey('kg', 'g')).toBe('UNIT_CONVERSION:kg->g');
    expect(buildUnitConversionKey('g', 'kg')).toBe('UNIT_CONVERSION:g->kg');
  });
});

describe('validateManifestNoDuplicateKeys', () => {
  it('does not throw when all keys are unique', () => {
    expect(() =>
      validateManifestNoDuplicateKeys([
        { manifestEntryKey: 'INVENTORY_CATEGORY:flavor' },
        { manifestEntryKey: 'INVENTORY_CATEGORY:topping' },
      ]),
    ).not.toThrow();
  });

  it('throws when two entries share the same normalized manifestEntryKey', () => {
    expect(() =>
      validateManifestNoDuplicateKeys([
        { manifestEntryKey: 'INVENTORY_CATEGORY:flavor' },
        { manifestEntryKey: 'INVENTORY_CATEGORY:flavor' },
      ]),
    ).toThrow();
  });
});
