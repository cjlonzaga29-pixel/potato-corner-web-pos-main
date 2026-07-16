import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findStatutoryDiscountsInWindow: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { discountIdReuseRule } = await import('./rule-discount-id-reuse.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function discountTxn(id: string, branchId: string, hash: string) {
  return { id, branchId, cashierId: 'user-1', discountCustomerIdHash: hash, createdAt: new Date() };
}

describe('discountIdReuseRule', () => {
  it('is a global-scope rule (not per-branch — Corrections #4)', () => {
    expect(discountIdReuseRule.scope).toBe('global');
  });

  it('flags a customer ID hash used more than 3 times in the window, even across different branches', async () => {
    vi.mocked(transactionsRepository.findStatutoryDiscountsInWindow).mockResolvedValue([
      discountTxn('txn-1', 'branch-1', 'hash-a'),
      discountTxn('txn-2', 'branch-2', 'hash-a'),
      discountTxn('txn-3', 'branch-1', 'hash-a'),
      discountTxn('txn-4', 'branch-3', 'hash-a'),
      discountTxn('txn-5', 'branch-1', 'hash-b'),
    ] as never);

    const result = await discountIdReuseRule.evaluate({ branchId: null, evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'discount_id_reuse',
        severity: 'high',
        branchId: null,
        employeeId: null,
        evidence: {
          customer_id_hash: 'hash-a',
          occurrence_count: 4,
          window_days: 30,
          transaction_ids: ['txn-1', 'txn-2', 'txn-3', 'txn-4'],
          branch_ids: ['branch-1', 'branch-2', 'branch-3'],
        },
      },
    ]);
  });

  it('does not flag a hash used exactly 3 times (threshold is >3)', async () => {
    vi.mocked(transactionsRepository.findStatutoryDiscountsInWindow).mockResolvedValue([
      discountTxn('txn-1', 'branch-1', 'hash-a'),
      discountTxn('txn-2', 'branch-1', 'hash-a'),
      discountTxn('txn-3', 'branch-1', 'hash-a'),
    ] as never);

    const result = await discountIdReuseRule.evaluate({ branchId: null, evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
