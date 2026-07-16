import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { discountAbuseRule } = await import('./rule-discount-abuse.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function discountedTxn(id: string, discountType: string) {
  return { id, status: 'completed', discountType, voidedAt: null };
}

describe('discountAbuseRule', () => {
  it('is a branch-scoped rule', () => {
    expect(discountAbuseRule.scope).toBe('branch');
  });

  it('flags a shift with more than 5 discounted completed transactions, of any discount type', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: [
          discountedTxn('txn-1', 'pwd'),
          discountedTxn('txn-2', 'senior_citizen'),
          discountedTxn('txn-3', 'promotional'),
          discountedTxn('txn-4', 'employee'),
          discountedTxn('txn-5', 'pwd'),
          discountedTxn('txn-6', 'promotional'),
        ],
      },
    ] as never);

    const result = await discountAbuseRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'discount_abuse',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: {
          shift_id: 'shift-1',
          discount_count: 6,
          discount_transaction_ids: ['txn-1', 'txn-2', 'txn-3', 'txn-4', 'txn-5', 'txn-6'],
        },
      },
    ]);
  });

  it('does not flag a shift with exactly 5 discounted transactions (threshold is >5)', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: Array.from({ length: 5 }, (_, i) => discountedTxn(`txn-${i}`, 'promotional')),
      },
    ] as never);

    const result = await discountAbuseRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
