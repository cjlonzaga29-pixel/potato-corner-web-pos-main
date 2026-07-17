import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./reports.repository.js', () => ({
  reportsRepository: {
    getDailySales: vi.fn(),
    countRows: vi.fn(),
  },
}));

vi.mock('../cash/cash.repository.js', () => ({
  cashRepository: {
    countUnresolvedVariancesInWindow: vi.fn(),
  },
}));

vi.mock('../fraud/fraud.repository.js', () => ({
  fraudRepository: {
    countAlertsCreatedInWindow: vi.fn(),
  },
}));

const { reportsRepository } = await import('./reports.repository.js');
const { cashRepository } = await import('../cash/cash.repository.js');
const { fraudRepository } = await import('../fraud/fraud.repository.js');
const { buildEodSummary } = await import('./eod-summary.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildEodSummary', () => {
  it('aggregates company-wide and per-branch figures for the Manila day window', async () => {
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue([
      {
        report_date: '2026-07-17',
        branch_id: 'branch-1',
        branch_name: 'Manila',
        gross_sales: 10000,
        discount_total: 500,
        vat_total: 1000,
        net_sales: 9000,
        completed_count: 40,
        voided_count: 2,
        refunded_count: 1,
      },
      {
        report_date: '2026-07-17',
        branch_id: 'branch-2',
        branch_name: 'Cebu',
        gross_sales: 5000,
        discount_total: 0,
        vat_total: 500,
        net_sales: 4500,
        completed_count: 20,
        voided_count: 0,
        refunded_count: 0,
      },
    ] as never);
    vi.mocked(reportsRepository.countRows).mockResolvedValue(3);
    vi.mocked(cashRepository.countUnresolvedVariancesInWindow).mockResolvedValue(1);
    vi.mocked(fraudRepository.countAlertsCreatedInWindow).mockResolvedValue(2);

    const result = await buildEodSummary(new Date('2026-07-17T15:00:00.000Z'));

    expect(reportsRepository.getDailySales).toHaveBeenCalledWith({
      dateFrom: new Date('2026-07-16T16:00:00.000Z'),
      dateTo: new Date('2026-07-17T15:59:59.999Z'),
      page: 1,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(reportsRepository.countRows).toHaveBeenCalledWith('VOID_REFUND', {
      dateFrom: new Date('2026-07-16T16:00:00.000Z'),
      dateTo: new Date('2026-07-17T15:59:59.999Z'),
      page: 1,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(cashRepository.countUnresolvedVariancesInWindow).toHaveBeenCalledWith(
      new Date('2026-07-16T16:00:00.000Z'),
      new Date('2026-07-17T15:59:59.999Z'),
    );
    expect(fraudRepository.countAlertsCreatedInWindow).toHaveBeenCalledWith(
      new Date('2026-07-16T16:00:00.000Z'),
      new Date('2026-07-17T15:59:59.999Z'),
    );

    expect(result).toEqual({
      evaluationDate: '2026-07-17',
      totalRevenue: 15000,
      branchRevenue: [
        { branchId: 'branch-1', branchName: 'Manila', revenue: 10000 },
        { branchId: 'branch-2', branchName: 'Cebu', revenue: 5000 },
      ],
      transactionCount: 60,
      voidCount: 3,
      unresolvedCashVarianceCount: 1,
      openFraudAlertsCreatedTodayCount: 2,
    });
  });

  it('returns zeroed figures when no branch had any sales that day', async () => {
    vi.mocked(reportsRepository.getDailySales).mockResolvedValue([]);
    vi.mocked(reportsRepository.countRows).mockResolvedValue(0);
    vi.mocked(cashRepository.countUnresolvedVariancesInWindow).mockResolvedValue(0);
    vi.mocked(fraudRepository.countAlertsCreatedInWindow).mockResolvedValue(0);

    const result = await buildEodSummary(new Date('2026-07-17T15:00:00.000Z'));

    expect(result).toEqual({
      evaluationDate: '2026-07-17',
      totalRevenue: 0,
      branchRevenue: [],
      transactionCount: 0,
      voidCount: 0,
      unresolvedCashVarianceCount: 0,
      openFraudAlertsCreatedTodayCount: 0,
    });
  });
});
