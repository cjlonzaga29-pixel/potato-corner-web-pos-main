import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { excessiveVoidsRule } = await import('./rule-excessive-voids.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('excessiveVoidsRule', () => {
  it('is a branch-scoped rule', () => {
    expect(excessiveVoidsRule.scope).toBe('branch');
  });

  it('returns [] when called with branchId: null', async () => {
    const result = await excessiveVoidsRule.evaluate({ branchId: null, evaluationDate: new Date() });
    expect(result).toEqual([]);
    expect(transactionsRepository.findClosedShiftTransactionSummaries).not.toHaveBeenCalled();
  });

  it('flags a shift with more than 3 voided transactions', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date('2026-07-17T10:00:00.000Z'),
        transactions: [
          { id: 'txn-1', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-2', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-3', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-4', status: 'voided', discountType: null, voidedAt: new Date() },
        ],
      },
    ] as never);

    const result = await excessiveVoidsRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date('2026-07-17T15:00:00.000Z') });

    expect(result).toEqual([
      {
        alertType: 'excessive_voids',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { shift_id: 'shift-1', void_count: 4, void_transaction_ids: ['txn-1', 'txn-2', 'txn-3', 'txn-4'] },
      },
    ]);
  });

  it('does not flag a shift with exactly 3 voided transactions (threshold is >3)', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: [
          { id: 'txn-1', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-2', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-3', status: 'voided', discountType: null, voidedAt: new Date() },
        ],
      },
    ] as never);

    const result = await excessiveVoidsRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
