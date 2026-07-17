import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const addMock = vi.fn();
const onMock = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
  Worker: vi.fn().mockImplementation((_name: string, processor: (job: Job) => Promise<void>) => ({
    on: onMock,
    __processor: processor,
  })),
}));

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn().mockReturnValue({ on: vi.fn() }),
}));

vi.mock('../modules/reports/eod-summary.service.js', () => ({
  buildEodSummary: vi.fn(),
}));

vi.mock('./notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { buildEodSummary } = await import('../modules/reports/eod-summary.service.js');
const { enqueueNotification } = await import('./notification.queue.js');
const { eodWorker, scheduleNightlyEodSummary } = await import('./eod.queue.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scheduleNightlyEodSummary', () => {
  it('registers a repeatable nightly_eod_summary job at 23:59 Asia/Manila with a fixed jobId', async () => {
    await scheduleNightlyEodSummary();

    expect(addMock).toHaveBeenCalledWith(
      'nightly_eod_summary',
      {},
      {
        repeat: { pattern: '59 23 * * *', tz: 'Asia/Manila' },
        jobId: 'eod-nightly-summary',
        attempts: 3,
        backoff: { type: 'custom' },
      },
    );
  });
});

describe('eodWorker processor', () => {
  it('builds the summary once and enqueues one eod_summary notification per branch, each carrying full company context', async () => {
    vi.mocked(buildEodSummary).mockResolvedValue({
      evaluationDate: '2026-07-17',
      totalRevenue: 20000,
      branchRevenue: [
        { branchId: 'branch-1', branchName: 'Manila', revenue: 15000 },
        { branchId: 'branch-2', branchName: 'Cebu', revenue: 5000 },
      ],
      transactionCount: 60,
      voidCount: 3,
      unresolvedCashVarianceCount: 1,
      openFraudAlertsCreatedTodayCount: 2,
    });
    const processor = (eodWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;

    await processor({ name: 'nightly_eod_summary', data: {} } as Job);

    expect(buildEodSummary).toHaveBeenCalledTimes(1);
    expect(buildEodSummary).toHaveBeenCalledWith(expect.any(Date));
    expect(enqueueNotification).toHaveBeenCalledTimes(2);
    expect(enqueueNotification).toHaveBeenCalledWith('eod_summary', {
      type: 'eod_summary',
      branchId: 'branch-1',
      businessDate: '2026-07-17',
      totalSales: 15000,
      totalRevenue: 20000,
      transactionCount: 60,
      voidCount: 3,
      unresolvedCashVarianceCount: 1,
      openFraudAlertsCreatedTodayCount: 2,
      branchRevenue: [
        { branchId: 'branch-1', branchName: 'Manila', revenue: 15000 },
        { branchId: 'branch-2', branchName: 'Cebu', revenue: 5000 },
      ],
    });
    expect(enqueueNotification).toHaveBeenCalledWith('eod_summary', {
      type: 'eod_summary',
      branchId: 'branch-2',
      businessDate: '2026-07-17',
      totalSales: 5000,
      totalRevenue: 20000,
      transactionCount: 60,
      voidCount: 3,
      unresolvedCashVarianceCount: 1,
      openFraudAlertsCreatedTodayCount: 2,
      branchRevenue: [
        { branchId: 'branch-1', branchName: 'Manila', revenue: 15000 },
        { branchId: 'branch-2', branchName: 'Cebu', revenue: 5000 },
      ],
    });
  });

  it('enqueues nothing when no branch had any sales that day', async () => {
    vi.mocked(buildEodSummary).mockResolvedValue({
      evaluationDate: '2026-07-17',
      totalRevenue: 0,
      branchRevenue: [],
      transactionCount: 0,
      voidCount: 0,
      unresolvedCashVarianceCount: 0,
      openFraudAlertsCreatedTodayCount: 0,
    });
    const processor = (eodWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;

    await processor({ name: 'nightly_eod_summary', data: {} } as Job);

    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});
