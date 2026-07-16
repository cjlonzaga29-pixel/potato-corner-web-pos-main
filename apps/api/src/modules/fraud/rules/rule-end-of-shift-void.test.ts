import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { endOfShiftVoidRule } = await import('./rule-end-of-shift-void.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('endOfShiftVoidRule', () => {
  it('is a branch-scoped rule', () => {
    expect(endOfShiftVoidRule.scope).toBe('branch');
  });

  it('flags a void that happened within the last 10 minutes before shift close', async () => {
    const closedAt = new Date('2026-07-17T22:00:00.000Z');
    const voidedAt = new Date('2026-07-17T21:55:00.000Z'); // 5 minutes before close
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt, transactions: [{ id: 'txn-1', status: 'voided', discountType: null, voidedAt }] },
    ] as never);

    const result = await endOfShiftVoidRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'end_of_shift_void',
        severity: 'low',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: {
          shift_id: 'shift-1',
          transaction_id: 'txn-1',
          voided_at: voidedAt.toISOString(),
          shift_closed_at: closedAt.toISOString(),
        },
      },
    ]);
  });

  it('does not flag a void that happened more than 10 minutes before shift close', async () => {
    const closedAt = new Date('2026-07-17T22:00:00.000Z');
    const voidedAt = new Date('2026-07-17T21:30:00.000Z'); // 30 minutes before close
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt, transactions: [{ id: 'txn-1', status: 'voided', discountType: null, voidedAt }] },
    ] as never);

    const result = await endOfShiftVoidRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });

  it('skips a shift with no closedAt', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt: null, transactions: [{ id: 'txn-1', status: 'voided', discountType: null, voidedAt: new Date() }] },
    ] as never);

    const result = await endOfShiftVoidRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
