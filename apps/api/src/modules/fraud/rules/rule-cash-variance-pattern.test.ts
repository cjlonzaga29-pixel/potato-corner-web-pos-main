import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cash/cash.repository.js', () => ({
  cashRepository: { findCashiersWithClosedShifts: vi.fn(), findLastNClosedShiftsForCashier: vi.fn() },
}));

const { cashRepository } = await import('../../cash/cash.repository.js');
const { cashVariancePatternRule } = await import('./rule-cash-variance-pattern.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function shift(id: string, varianceApproved: boolean | null) {
  return { id, varianceApproved, closedAt: new Date() };
}

describe('cashVariancePatternRule', () => {
  it('is a branch-scoped rule', () => {
    expect(cashVariancePatternRule.scope).toBe('branch');
  });

  it('flags a cashier with variance in more than 30% of their last 10 closed shifts', async () => {
    vi.mocked(cashRepository.findCashiersWithClosedShifts).mockResolvedValue(['user-1']);
    vi.mocked(cashRepository.findLastNClosedShiftsForCashier).mockResolvedValue([
      shift('s1', true), shift('s2', true), shift('s3', true), shift('s4', false),
      shift('s5', null), shift('s6', null), shift('s7', null), shift('s8', null), shift('s9', null), shift('s10', null),
    ] as never);

    const result = await cashVariancePatternRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'cash_variance_pattern',
        severity: 'high',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { variance_count: 4, shifts_checked: 10, ratio: 0.4, shift_ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] },
      },
    ]);
  });

  it('does not flag a cashier with variance in exactly 30% of shifts (threshold is >30%)', async () => {
    vi.mocked(cashRepository.findCashiersWithClosedShifts).mockResolvedValue(['user-1']);
    vi.mocked(cashRepository.findLastNClosedShiftsForCashier).mockResolvedValue([
      shift('s1', true), shift('s2', true), shift('s3', true),
      shift('s4', null), shift('s5', null), shift('s6', null), shift('s7', null), shift('s8', null), shift('s9', null), shift('s10', null),
    ] as never);

    const result = await cashVariancePatternRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });

  it('skips a cashier with fewer than 10 closed shifts in their history', async () => {
    vi.mocked(cashRepository.findCashiersWithClosedShifts).mockResolvedValue(['user-1']);
    vi.mocked(cashRepository.findLastNClosedShiftsForCashier).mockResolvedValue([shift('s1', true), shift('s2', true)] as never);

    const result = await cashVariancePatternRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
