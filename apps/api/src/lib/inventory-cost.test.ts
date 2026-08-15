import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { blendWeightedAverageCost } from './inventory-cost.js';

function dec(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('blendWeightedAverageCost', () => {
  it('matches the spec example: 50 @ ₱8 + 100 @ ₱10 -> ₱9.333...', () => {
    const result = blendWeightedAverageCost(dec(50), dec(8), dec(100), dec(10));
    expect(result.toDecimalPlaces(4).toString()).toBe('9.3333');
  });

  it('initial receiving: 0 existing + 100 @ ₱10 -> ₱10', () => {
    const result = blendWeightedAverageCost(dec(0), null, dec(100), dec(10));
    expect(result.toString()).toBe('10');
  });

  it('bootstraps from an unknown (null) existing cost by adopting the incoming cost outright', () => {
    const result = blendWeightedAverageCost(dec(20), null, dec(10), dec(5));
    expect(result.toString()).toBe('5');
  });

  it('transfer-destination example: 20 @ ₱8 + 10 @ ₱10 -> ₱8.666...', () => {
    const result = blendWeightedAverageCost(dec(20), dec(8), dec(10), dec(10));
    expect(result.toDecimalPlaces(4).toString()).toBe('8.6667');
  });
});
