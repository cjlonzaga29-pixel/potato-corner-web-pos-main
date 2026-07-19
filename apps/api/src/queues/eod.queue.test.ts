import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 21: BullMQ removed — eod.queue.ts now registers its nightly job via
 * lib/daily-scheduler.ts's scheduleDaily and runs the job body directly
 * (retried via lib/job-runner.ts's runWithRetry) instead of dispatching
 * through a BullMQ Worker. scheduleDaily is mocked out entirely (its own
 * wall-clock/setTimeout math is covered by daily-scheduler.test.ts) so we
 * can capture and invoke the task it was registered with. job-runner is
 * mocked as a thin wrapper around the real implementation (via
 * importOriginal) so retry/backoff behavior stays real — including actual
 * setTimeout delays under vi.useFakeTimers() — while still letting us assert
 * on call arguments (e.g. the RETRY_DELAYS_MS array).
 */
vi.mock('../lib/daily-scheduler.js', () => ({
  scheduleDaily: vi.fn(),
}));

vi.mock('../lib/job-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../lib/job-runner.js');
  return {
    ...actual,
    runWithRetry: vi.fn(actual.runWithRetry),
  };
});

vi.mock('../modules/reports/eod-summary.service.js', () => ({
  buildEodSummary: vi.fn(),
}));

vi.mock('./notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { scheduleDaily } = await import('../lib/daily-scheduler.js');
const { runWithRetry } = await import('../lib/job-runner.js');
const { buildEodSummary } = await import('../modules/reports/eod-summary.service.js');
const { enqueueNotification } = await import('./notification.queue.js');
const { scheduleNightlyEodSummary } = await import('./eod.queue.js');

/** The daily task registered with scheduleDaily by the most recent scheduleNightlyEodSummary() call. */
function nightlyTask(): () => Promise<void> {
  const call = vi.mocked(scheduleDaily).mock.calls.at(-1);
  if (!call) throw new Error('scheduleDaily was never called');
  return call[3];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleNightlyEodSummary', () => {
  it('registers the nightly EOD summary at 23:59 Asia/Manila', async () => {
    await scheduleNightlyEodSummary();

    expect(scheduleDaily).toHaveBeenCalledTimes(1);
    expect(scheduleDaily).toHaveBeenCalledWith(23, 59, 'Asia/Manila', expect.any(Function));
  });
});

describe('nightly EOD summary task', () => {
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

    await scheduleNightlyEodSummary();
    await nightlyTask()();

    expect(buildEodSummary).toHaveBeenCalledTimes(1);
    expect(buildEodSummary).toHaveBeenCalledWith(expect.any(Date));
    // The nightly task's own retry policy — 10s/60s/300s, same schedule as fraud/inventory/report queues (Phase 18 Decision 7).
    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
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

    await scheduleNightlyEodSummary();
    await nightlyTask()();

    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('retries a transient failure and still succeeds once buildEodSummary recovers', async () => {
    vi.useFakeTimers();
    vi.mocked(buildEodSummary)
      .mockRejectedValueOnce(new Error('db unreachable'))
      .mockResolvedValueOnce({
        evaluationDate: '2026-07-17',
        totalRevenue: 1000,
        branchRevenue: [{ branchId: 'branch-1', branchName: 'Manila', revenue: 1000 }],
        transactionCount: 5,
        voidCount: 0,
        unresolvedCashVarianceCount: 0,
        openFraudAlertsCreatedTodayCount: 0,
      });

    await scheduleNightlyEodSummary();
    const taskPromise = nightlyTask()();
    await vi.advanceTimersByTimeAsync(10_000);
    await taskPromise;

    expect(buildEodSummary).toHaveBeenCalledTimes(2);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('logs a permanent failure once every retry attempt is exhausted, without throwing out of the scheduled task', async () => {
    vi.useFakeTimers();
    vi.mocked(buildEodSummary).mockRejectedValue(new Error('db unreachable'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await scheduleNightlyEodSummary();
    const taskPromise = nightlyTask()();
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);
    await expect(taskPromise).resolves.toBeUndefined();

    expect(buildEodSummary).toHaveBeenCalledTimes(3);
    expect(consoleErrorSpy).toHaveBeenCalledWith('EOD summary job permanently failed after 3 attempts:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});
