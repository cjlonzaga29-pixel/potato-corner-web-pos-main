import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { computeFingerprint } from './fingerprint.js';

describe('computeFingerprint', () => {
  it('produces the same hash regardless of key insertion order', () => {
    const a = computeFingerprint(
      'InventoryCategory',
      { name: 'Flavor', code: 'FLAVOR', description: 'Flavor powders', isActive: true },
      1,
    );
    const b = computeFingerprint(
      'InventoryCategory',
      { isActive: true, description: 'Flavor powders', code: 'FLAVOR', name: 'Flavor' },
      1,
    );
    expect(a.hash).toBe(b.hash);
  });

  it('returns fingerprintVersion and decimalCanonicalizationVersion alongside the hash', () => {
    const result = computeFingerprint(
      'InventoryCategory',
      { name: 'Flavor', code: 'FLAVOR', description: null, isActive: true },
      1,
    );
    expect(result.fingerprintVersion).toBe(1);
    expect(result.decimalCanonicalizationVersion).toBe(1);
    expect(typeof result.hash).toBe('string');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when a rollback-relevant field changes', () => {
    const before = computeFingerprint(
      'InventoryCategory',
      { name: 'Flavor', code: 'FLAVOR', description: null, isActive: true },
      1,
    );
    const after = computeFingerprint(
      'InventoryCategory',
      { name: 'Flavor', code: 'FLAVOR', description: null, isActive: false },
      1,
    );
    expect(before.hash).not.toBe(after.hash);
  });

  it('is unchanged when excluded fields (id, createdAt, updatedAt) differ', () => {
    const first = computeFingerprint(
      'InventoryCategory',
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'Flavor',
        code: 'FLAVOR',
        description: null,
        isActive: true,
        createdAt: new Date('2020-01-01T00:00:00Z'),
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      },
      1,
    );
    const second = computeFingerprint(
      'InventoryCategory',
      {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        name: 'Flavor',
        code: 'FLAVOR',
        description: null,
        isActive: true,
        createdAt: new Date('2024-06-15T12:34:56Z'),
        updatedAt: new Date('2026-07-27T09:00:00Z'),
      },
      1,
    );
    expect(first.hash).toBe(second.hash);
  });

  it('canonicalizes decimal-typed fields (UnitConversion.factor) before hashing', () => {
    const withStringFactor = computeFingerprint(
      'UnitConversion',
      { fromUnitId: 'unit-kg', toUnitId: 'unit-g', factor: '1000.000' },
      1,
    );
    const withDecimalFactor = computeFingerprint(
      'UnitConversion',
      { fromUnitId: 'unit-kg', toUnitId: 'unit-g', factor: new Prisma.Decimal('1000') },
      1,
    );
    expect(withStringFactor.hash).toBe(withDecimalFactor.hash);
  });

  it('changes the hash when the decimal factor value differs, even after canonicalization', () => {
    const factorA = computeFingerprint(
      'UnitConversion',
      { fromUnitId: 'unit-kg', toUnitId: 'unit-g', factor: '1000' },
      1,
    );
    const factorB = computeFingerprint(
      'UnitConversion',
      { fromUnitId: 'unit-kg', toUnitId: 'unit-g', factor: '1000.0001' },
      1,
    );
    expect(factorA.hash).not.toBe(factorB.hash);
  });

  it('throws for an unknown entityType', () => {
    expect(() => computeFingerprint('NotARealEntity', { name: 'x' }, 1)).toThrow();
  });

  it('throws for an unsupported fingerprintVersion', () => {
    expect(() =>
      computeFingerprint('InventoryCategory', { name: 'Flavor', code: 'FLAVOR', description: null, isActive: true }, 2),
    ).toThrow();
  });
});
