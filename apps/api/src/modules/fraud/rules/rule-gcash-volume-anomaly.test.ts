import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findGcashCountsByCashierForDate: vi.fn(), countGcashTransactionsForBranchWindow: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { gcashVolumeAnomalyRule } = await import('./rule-gcash-volume-anomaly.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gcashVolumeAnomalyRule', () => {
  it('is a branch-scoped rule', () => {
    expect(gcashVolumeAnomalyRule.scope).toBe('branch');
  });

  it('flags a cashier whose GCash count today is more than 50% above the 30-day branch daily average', async () => {
    // 300 GCash transactions over 30 days = average 10/day; 1.5x threshold = 15; 16 > 15
    vi.mocked(transactionsRepository.countGcashTransactionsForBranchWindow).mockResolvedValue(300);
    vi.mocked(transactionsRepository.findGcashCountsByCashierForDate).mockResolvedValue([{ cashierId: 'user-1', gcashCount: 16 }]);

    const result = await gcashVolumeAnomalyRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'gcash_volume_anomaly',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { gcash_count_today: 16, branch_daily_average: 10, threshold: 15, window_days: 30 },
      },
    ]);
  });

  it('does not flag a cashier at or below the threshold', async () => {
    vi.mocked(transactionsRepository.countGcashTransactionsForBranchWindow).mockResolvedValue(300);
    vi.mocked(transactionsRepository.findGcashCountsByCashierForDate).mockResolvedValue([{ cashierId: 'user-1', gcashCount: 15 }]);

    const result = await gcashVolumeAnomalyRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });

  it('skips the check entirely when the branch has no GCash history (average is 0)', async () => {
    vi.mocked(transactionsRepository.countGcashTransactionsForBranchWindow).mockResolvedValue(0);
    vi.mocked(transactionsRepository.findGcashCountsByCashierForDate).mockResolvedValue([{ cashierId: 'user-1', gcashCount: 5 }]);

    const result = await gcashVolumeAnomalyRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
