import { describe, it, expect } from 'vitest';
import { computeDeductionTotals, sortedDeductionTotalEntries } from './deduction-totals.js';

describe('computeDeductionTotals', () => {
  it('sums quantities for the same ingredient across multiple lines and multiple items', () => {
    const totals = computeDeductionTotals([
      { lines: [{ inventoryItemId: 'flour', baseUnitId: 'g', quantity: 2 }] },
      { lines: [{ inventoryItemId: 'flour', baseUnitId: 'g', quantity: 3 }, { inventoryItemId: 'sugar', baseUnitId: 'g', quantity: 1 }] },
    ]);

    expect(totals.get('flour')).toEqual({ quantity: 5, baseUnitId: 'g' });
    expect(totals.get('sugar')).toEqual({ quantity: 1, baseUnitId: 'g' });
  });

  it('returns an empty map for a cart with no deduction lines', () => {
    expect(computeDeductionTotals([{ lines: [] }]).size).toBe(0);
  });
});

describe('sortedDeductionTotalEntries', () => {
  it('orders entries ascending by inventoryItemId regardless of insertion order — the deterministic lock/update order two concurrent sales must share to avoid a Postgres deadlock', () => {
    const totals = computeDeductionTotals([
      { lines: [{ inventoryItemId: 'zucchini', baseUnitId: 'g', quantity: 1 }, { inventoryItemId: 'apple', baseUnitId: 'g', quantity: 1 }, { inventoryItemId: 'mango', baseUnitId: 'g', quantity: 1 }] },
    ]);

    expect(sortedDeductionTotalEntries(totals).map(([id]) => id)).toEqual(['apple', 'mango', 'zucchini']);
  });
});
