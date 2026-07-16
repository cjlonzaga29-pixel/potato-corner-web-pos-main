import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { employeeSelfDiscountRule } = await import('./rule-employee-self-discount.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function txn(id: string, discountType: string | null) {
  return { id, status: 'completed', discountType, voidedAt: null };
}

describe('employeeSelfDiscountRule', () => {
  it('is a branch-scoped rule', () => {
    expect(employeeSelfDiscountRule.scope).toBe('branch');
  });

  it('flags a shift with more than 2 employee-discount transactions, ignoring other discount types', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: [txn('txn-1', 'employee'), txn('txn-2', 'employee'), txn('txn-3', 'employee'), txn('txn-4', 'pwd')],
      },
    ] as never);

    const result = await employeeSelfDiscountRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'employee_self_discount_frequency',
        severity: 'low',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { shift_id: 'shift-1', employee_discount_count: 3, employee_discount_transaction_ids: ['txn-1', 'txn-2', 'txn-3'] },
      },
    ]);
  });

  it('does not flag a shift with exactly 2 employee-discount transactions (threshold is >2)', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt: new Date(), transactions: [txn('txn-1', 'employee'), txn('txn-2', 'employee')] },
    ] as never);

    const result = await employeeSelfDiscountRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
