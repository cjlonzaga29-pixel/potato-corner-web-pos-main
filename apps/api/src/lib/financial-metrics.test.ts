import { describe, it, expect } from 'vitest';
import { computeFinancialMetrics } from './financial-metrics.js';

describe('computeFinancialMetrics', () => {
  it('gross sales is the pre-discount figure, passed through unchanged', () => {
    const result = computeFinancialMetrics({ grossSales: 1000, discountTotal: 0, refundTotal: 0, expenseTotal: 0 });
    expect(result.grossSales).toBe(1000);
  });

  it('net sales subtracts both discounts and refunds from gross sales', () => {
    const result = computeFinancialMetrics({ grossSales: 1000, discountTotal: 100, refundTotal: 50, expenseTotal: 0 });
    expect(result.netSales).toBe(850);
  });

  it('discount total is carried through unchanged', () => {
    const result = computeFinancialMetrics({ grossSales: 1000, discountTotal: 150, refundTotal: 0, expenseTotal: 0 });
    expect(result.discountTotal).toBe(150);
  });

  it('refund total is subtracted from net sales, not added back to gross sales', () => {
    const result = computeFinancialMetrics({ grossSales: 1000, discountTotal: 0, refundTotal: 200, expenseTotal: 0 });
    expect(result.grossSales).toBe(1000);
    expect(result.refundTotal).toBe(200);
    expect(result.netSales).toBe(800);
  });

  it('net operating result is net sales minus operating expenses — no COGS/waste dependency', () => {
    const result = computeFinancialMetrics({ grossSales: 1000, discountTotal: 100, refundTotal: 50, expenseTotal: 120 });
    // netSales = 850, netOperatingResult = 730
    expect(result.netSales).toBe(850);
    expect(result.netOperatingResult).toBe(730);
  });

  it('a zero-activity period reports zero for every field, not a misleading nonzero figure', () => {
    const result = computeFinancialMetrics({ grossSales: 0, discountTotal: 0, refundTotal: 0, expenseTotal: 0 });
    expect(result).toEqual({
      grossSales: 0,
      discountTotal: 0,
      refundTotal: 0,
      netSales: 0,
      expenseTotal: 0,
      netOperatingResult: 0,
    });
  });

  it('zero expenses: net operating result equals net sales', () => {
    const result = computeFinancialMetrics({ grossSales: 10000, discountTotal: 500, refundTotal: 1000, expenseTotal: 0 });
    expect(result.netSales).toBe(8500);
    expect(result.netOperatingResult).toBe(8500);
  });

  it('zero refunds: net sales only subtracts discounts', () => {
    const result = computeFinancialMetrics({ grossSales: 10000, discountTotal: 500, refundTotal: 0, expenseTotal: 2000 });
    expect(result.netSales).toBe(9500);
    expect(result.netOperatingResult).toBe(7500);
  });

  it('zero discounts: net sales only subtracts refunds', () => {
    const result = computeFinancialMetrics({ grossSales: 10000, discountTotal: 0, refundTotal: 1000, expenseTotal: 2000 });
    expect(result.netSales).toBe(9000);
    expect(result.netOperatingResult).toBe(7000);
  });

  it('gross sales 10000, discounts 500, refunds 1000, expenses 2000 -> net operating result 6500 (canonical worked example)', () => {
    const result = computeFinancialMetrics({ grossSales: 10000, discountTotal: 500, refundTotal: 1000, expenseTotal: 2000 });
    expect(result.netSales).toBe(8500);
    expect(result.netOperatingResult).toBe(6500);
  });

  it('does not double-subtract VAT — grossSales/discountTotal/refundTotal alone determine netSales', () => {
    // VAT is embedded in totalAmount (and thus in gross/discount/refund figures
    // derived from it) — computeFinancialMetrics never takes a vatAmount input,
    // so there is no way for it to subtract VAT a second time.
    const result = computeFinancialMetrics({ grossSales: 1120, discountTotal: 0, refundTotal: 0, expenseTotal: 0 });
    expect(result.netSales).toBe(1120);
  });

  it('summing per-branch metrics equals the metrics computed from the combined totals (admin aggregation parity)', () => {
    const branchA = { grossSales: 1000, discountTotal: 100, refundTotal: 50, expenseTotal: 120 };
    const branchB = { grossSales: 2000, discountTotal: 50, refundTotal: 0, expenseTotal: 80 };

    const metricsA = computeFinancialMetrics(branchA);
    const metricsB = computeFinancialMetrics(branchB);
    const combined = computeFinancialMetrics({
      grossSales: branchA.grossSales + branchB.grossSales,
      discountTotal: branchA.discountTotal + branchB.discountTotal,
      refundTotal: branchA.refundTotal + branchB.refundTotal,
      expenseTotal: branchA.expenseTotal + branchB.expenseTotal,
    });

    expect(combined.netSales).toBe(round2(metricsA.netSales + metricsB.netSales));
    expect(combined.netOperatingResult).toBe(round2(metricsA.netOperatingResult + metricsB.netOperatingResult));
  });
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
