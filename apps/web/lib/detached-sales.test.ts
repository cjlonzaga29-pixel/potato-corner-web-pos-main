import { describe, it, expect } from 'vitest';
import { pruneConfirmedDetachedSales, MAX_RETAINED_CONFIRMED_SALES, type DetachedSale } from './detached-sales';

function entry(overrides: Partial<DetachedSale> = {}): DetachedSale {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'key',
    snapshot: {
      orderRef: 1,
      items: [],
      subtotal: 0,
      discountAmount: 0,
      discountType: null,
      vatAmount: 0,
      totalAmount: 0,
      paymentMethod: 'cash',
      cashTendered: null,
      changeGiven: null,
    },
    payload: { branch_id: 'branch-1', items: [], payment_method: 'cash' } as never,
    status: 'success',
    transaction: null,
    errorMessage: null,
    safeToRetryDirectly: false,
    createdAt: 0,
    ...overrides,
  };
}

describe('pruneConfirmedDetachedSales', () => {
  it('leaves the list untouched when under the cap', () => {
    const entries = [entry({ idempotencyKey: 'a', createdAt: 1 }), entry({ idempotencyKey: 'b', createdAt: 2 })];
    expect(pruneConfirmedDetachedSales(entries)).toHaveLength(2);
  });

  it('never discards unresolved (saving/error) entries, regardless of how many confirmed entries exist', () => {
    const confirmed = Array.from({ length: MAX_RETAINED_CONFIRMED_SALES + 5 }, (_, i) =>
      entry({ idempotencyKey: `confirmed-${i}`, createdAt: i }),
    );
    const unresolved = [
      entry({ idempotencyKey: 'saving-1', status: 'saving', createdAt: 1000 }),
      entry({ idempotencyKey: 'error-1', status: 'error', createdAt: 1001 }),
    ];

    const result = pruneConfirmedDetachedSales([...confirmed, ...unresolved]);

    expect(result.find((e) => e.idempotencyKey === 'saving-1')).toBeDefined();
    expect(result.find((e) => e.idempotencyKey === 'error-1')).toBeDefined();
  });

  it('keeps only the most recent MAX_RETAINED_CONFIRMED_SALES confirmed entries, dropping older ones', () => {
    const confirmed = Array.from({ length: MAX_RETAINED_CONFIRMED_SALES + 5 }, (_, i) =>
      entry({ idempotencyKey: `confirmed-${i}`, createdAt: i }),
    );

    const result = pruneConfirmedDetachedSales(confirmed);

    expect(result).toHaveLength(MAX_RETAINED_CONFIRMED_SALES);
    // The newest (highest createdAt) entries survive; the oldest are dropped.
    expect(result.find((e) => e.idempotencyKey === 'confirmed-0')).toBeUndefined();
    expect(result.find((e) => e.idempotencyKey === `confirmed-${MAX_RETAINED_CONFIRMED_SALES + 4}`)).toBeDefined();
  });
});
