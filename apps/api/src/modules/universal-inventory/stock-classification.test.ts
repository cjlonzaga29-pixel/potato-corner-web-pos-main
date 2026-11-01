import { describe, expect, it } from 'vitest';
import { availableStock, classifyStockStatus } from './stock-classification.js';

describe('classifyStockStatus (POS-PERF-P56)', () => {
  it('nothing available is critical, even with no thresholds', () => {
    expect(classifyStockStatus(0, null, null)).toBe('critical');
    expect(classifyStockStatus(-1, null, null)).toBe('critical');
    expect(classifyStockStatus(0, 10, 5)).toBe('critical');
  });

  it('positive stock without thresholds is healthy: no threshold is invented', () => {
    expect(classifyStockStatus(0.001, null, null)).toBe('healthy');
    expect(classifyStockStatus(1, null, null)).toBe('healthy');
  });

  it('keeps the threshold rule for positive stock', () => {
    expect(classifyStockStatus(5, 10, 5)).toBe('critical');
    expect(classifyStockStatus(6, 10, 5)).toBe('low');
    expect(classifyStockStatus(10, 10, null)).toBe('low');
    expect(classifyStockStatus(11, 10, 5)).toBe('healthy');
  });
});

describe('availableStock', () => {
  it('is on hand minus reserved, floored at zero', () => {
    expect(availableStock(10, 4)).toBe(6);
    expect(availableStock(4, 4)).toBe(0);
    expect(availableStock(4, 9)).toBe(0);
    expect(availableStock(-2, 0)).toBe(0);
  });
});
