import { describe, it, expect } from 'vitest';
import { computePromotionUnitDiscount } from '@potato-corner/shared';
import {
  productIneligibilityReason,
  promotionScheduleState,
  selectPromotionForUnit,
  type PromotionCandidate,
} from './promotion-pricing.js';
import { manilaDateKey } from '../../lib/manila-time.js';

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    id: 'p-a',
    name: 'Promo A',
    discountKind: 'percentage',
    discountValue: 10,
    isEnabled: true,
    startsOn: null,
    endsOn: null,
    version: 1,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

describe('computePromotionUnitDiscount (P49)', () => {
  it('rounds a percentage once per unit to cents, half-up', () => {
    expect(computePromotionUnitDiscount(39, 'percentage', 15)).toBe(5.85);
    expect(computePromotionUnitDiscount(39.99, 'percentage', 12.5)).toBe(5); // 4.99875 -> 5.00
    // Same Math.round(x * 100) / 100 as checkout's round2, float artifacts included:
    // 1.15 * 0.5 is 0.57499999… in binary, so it rounds to 0.57 here and in checkout alike.
    expect(computePromotionUnitDiscount(1.15, 'percentage', 50)).toBe(Math.round(1.15 * 0.5 * 100) / 100);
  });

  it('applies a fixed amount per unit, capped at the base price, never negative', () => {
    expect(computePromotionUnitDiscount(39, 'fixed_amount', 10)).toBe(10);
    expect(computePromotionUnitDiscount(39, 'fixed_amount', 50)).toBe(39);
    expect(computePromotionUnitDiscount(39, 'percentage', 100)).toBe(39);
  });

  it('returns 0 for a non-positive price or value', () => {
    expect(computePromotionUnitDiscount(0, 'fixed_amount', 10)).toBe(0);
    expect(computePromotionUnitDiscount(39, 'percentage', 0)).toBe(0);
  });
});

describe('promotionScheduleState (P49, Asia/Manila inclusive dates)', () => {
  it('is active on both boundary days and outside them scheduled/expired', () => {
    const promo = { isEnabled: true, startsOn: '2026-11-01', endsOn: '2026-11-03' };
    expect(promotionScheduleState(promo, '2026-10-31')).toBe('scheduled');
    expect(promotionScheduleState(promo, '2026-11-01')).toBe('active');
    expect(promotionScheduleState(promo, '2026-11-03')).toBe('active');
    expect(promotionScheduleState(promo, '2026-11-04')).toBe('expired');
  });

  it('treats a missing date as open-ended and disabled as disabled regardless of dates', () => {
    expect(promotionScheduleState({ isEnabled: true, startsOn: null, endsOn: null }, '2030-01-01')).toBe('active');
    expect(promotionScheduleState({ isEnabled: false, startsOn: null, endsOn: null }, '2026-11-01')).toBe('disabled');
  });

  it('evaluates the Manila calendar day, not the UTC one', () => {
    const promo = { isEnabled: true, startsOn: '2026-11-01', endsOn: '2026-11-01' };
    // 2026-10-31T16:00Z = 2026-11-01 00:00 Manila; 2026-11-01T15:59:59Z = 23:59:59 Manila.
    expect(promotionScheduleState(promo, manilaDateKey(new Date('2026-10-31T15:59:59.999Z')))).toBe('scheduled');
    expect(promotionScheduleState(promo, manilaDateKey(new Date('2026-10-31T16:00:00.000Z')))).toBe('active');
    expect(promotionScheduleState(promo, manilaDateKey(new Date('2026-11-01T15:59:59.999Z')))).toBe('active');
    expect(promotionScheduleState(promo, manilaDateKey(new Date('2026-11-01T16:00:00.000Z')))).toBe('expired');
  });
});

describe('selectPromotionForUnit (P49 overlap rule)', () => {
  it('gives the unit exactly one promotion: the largest unit discount', () => {
    const tenPercent = candidate({ id: 'p-10', discountValue: 10 });
    const fivePesos = candidate({ id: 'p-5', discountKind: 'fixed_amount', discountValue: 5 });
    // 10% of 39 = 3.90 < 5.00
    expect(selectPromotionForUnit([tenPercent, fivePesos], 39, '2026-11-01')).toMatchObject({ promotion: { id: 'p-5' }, unitDiscount: 5 });
    // 10% of 99 = 9.90 > 5.00
    expect(selectPromotionForUnit([fivePesos, tenPercent], 99, '2026-11-01')).toMatchObject({ promotion: { id: 'p-10' }, unitDiscount: 9.9 });
  });

  it('breaks ties by earliest creation, then lowest id, independent of input order', () => {
    const older = candidate({ id: 'p-z', createdAt: new Date('2026-10-01T00:00:00Z') });
    const newer = candidate({ id: 'p-a', createdAt: new Date('2026-10-02T00:00:00Z') });
    expect(selectPromotionForUnit([newer, older], 50, '2026-11-01')?.promotion.id).toBe('p-z');
    expect(selectPromotionForUnit([older, newer], 50, '2026-11-01')?.promotion.id).toBe('p-z');
    const sameTimeB = candidate({ id: 'p-b' });
    const sameTimeA = candidate({ id: 'p-a' });
    expect(selectPromotionForUnit([sameTimeB, sameTimeA], 50, '2026-11-01')?.promotion.id).toBe('p-a');
  });

  it('ignores disabled, not-yet-started and expired promotions', () => {
    const list = [
      candidate({ id: 'off', isEnabled: false, discountValue: 90 }),
      candidate({ id: 'later', startsOn: '2026-12-01', discountValue: 80 }),
      candidate({ id: 'over', endsOn: '2026-10-31', discountValue: 70 }),
    ];
    expect(selectPromotionForUnit(list, 50, '2026-11-01')).toBeNull();
  });
});

describe('productIneligibilityReason (P49)', () => {
  it('allows promotional/seasonal products and refuses regular, archived/discontinued and VAT-capped ones', () => {
    expect(productIneligibilityReason({ classification: 'promotional', status: 'active', variants: [{ vatableCapAmount: null }] })).toBeNull();
    expect(productIneligibilityReason({ classification: 'seasonal', status: 'draft', variants: [] })).toBeNull();
    expect(productIneligibilityReason({ classification: 'regular', status: 'active', variants: [] })).toMatch(/Promotional or Seasonal/);
    expect(productIneligibilityReason({ classification: 'promotional', status: 'archived', variants: [] })).toMatch(/Archived/);
    expect(productIneligibilityReason({ classification: 'promotional', status: 'discontinued', variants: [] })).toMatch(/discontinued/);
    expect(productIneligibilityReason({ classification: 'promotional', status: 'active', variants: [{ vatableCapAmount: 99 }] })).toMatch(/VATable price cap/);
  });
});
