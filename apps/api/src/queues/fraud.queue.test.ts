import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 21: BullMQ removed — fraud.queue.ts now registers its nightly scan
 * via lib/daily-scheduler.ts's scheduleDaily and runs both the nightly and
 * manual scans directly (retried via lib/job-runner.ts's runWithRetry /
 * fired via runFireAndForget) instead of dispatching through a BullMQ
 * Worker. scheduleDaily is mocked out entirely (its own wall-clock/setTimeout
 * math is covered by daily-scheduler.test.ts). job-runner is mocked as a
 * thin wrapper around the real implementation (via importOriginal) so
 * retry/backoff/fire-and-forget behavior stays real — including actual
 * setTimeout delays under vi.useFakeTimers() — while still letting us assert
 * on call arguments.
 */
vi.mock('../lib/daily-scheduler.js', () => ({
  scheduleDaily: vi.fn(),
}));

vi.mock('../lib/job-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../lib/job-runner.js');
  return {
    ...actual,
    runWithRetry: vi.fn(actual.runWithRetry),
    runFireAndForget: vi.fn(actual.runFireAndForget),
  };
});

vi.mock('../modules/fraud/detection.service.js', () => ({
  runDetection: vi.fn(),
}));

vi.mock('../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

const { scheduleDaily } = await import('../lib/daily-scheduler.js');
const { runWithRetry } = await import('../lib/job-runner.js');
const { runDetection } = await import('../modules/fraud/detection.service.js');
const { notifySuperAdmin } = await import('../lib/notify.js');
const Sentry = await import('@sentry/node');
const { scheduleNightlyFraudScan, enqueueManualFraudScan } = await import('./fraud.queue.js');

/** The daily task registered with scheduleDaily by the most recent scheduleNightlyFraudScan() call. */
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

describe('scheduleNightlyFraudScan', () => {
  it('registers the nightly fraud scan at 23:00 Asia/Manila', async () => {
    await scheduleNightlyFraudScan();

    expect(scheduleDaily).toHaveBeenCalledTimes(1);
    expect(scheduleDaily).toHaveBeenCalledWith(23, 0, 'Asia/Manila', expect.any(Function));
  });
});

describe('nightly fraud scan task', () => {
  it('calls runDetection for "today" with the Decision 7 retry policy', async () => {
    vi.mocked(runDetection).mockResolvedValue({ branchesEvaluated: 3, rulesEvaluated: 7, alertsCreated: 1, alertsSkippedDupe: 0 });

    await scheduleNightlyFraudScan();
    await nightlyTask()();

    expect(runDetection).toHaveBeenCalledWith(expect.any(Date));
    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
  });

  it('retries a transient failure and does not report to Sentry/notify Super Admin once it recovers', async () => {
    vi.useFakeTimers();
    vi.mocked(runDetection)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ branchesEvaluated: 3, rulesEvaluated: 7, alertsCreated: 1, alertsSkippedDupe: 0 });

    await scheduleNightlyFraudScan();
    const taskPromise = nightlyTask()();
    await vi.advanceTimersByTimeAsync(10_000);
    await taskPromise;

    expect(runDetection).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
  });

  it('reports to Sentry and notifies Super Admin only after every retry attempt is exhausted', async () => {
    vi.useFakeTimers();
    vi.mocked(runDetection).mockRejectedValue(new Error('Redis unreachable'));

    await scheduleNightlyFraudScan();
    const taskPromise = nightlyTask()();
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);
    await taskPromise;

    expect(runDetection).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(notifySuperAdmin).toHaveBeenCalledWith('fraud:scan_failed', {
      job_name: 'nightly_scan',
      error: 'Redis unreachable',
      attempts: 3,
    });
  });
});

describe('enqueueManualFraudScan', () => {
  it('runs runDetection with the job-provided evaluationDate, in the background, with the Decision 7 retry policy', async () => {
    vi.mocked(runDetection).mockResolvedValue({ branchesEvaluated: 1, rulesEvaluated: 7, alertsCreated: 0, alertsSkippedDupe: 0 });

    await enqueueManualFraudScan({ evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' });
    await vi.waitFor(() => expect(runDetection).toHaveBeenCalled());

    expect(runDetection).toHaveBeenCalledWith(new Date('2026-07-17T00:00:00.000Z'));
    expect(runWithRetry).toHaveBeenCalledWith(expect.any(Function), [10_000, 60_000, 300_000]);
  });

  it('reports to Sentry and notifies Super Admin with job_name "manual_scan" only after every retry attempt is exhausted', async () => {
    vi.useFakeTimers();
    vi.mocked(runDetection).mockRejectedValue(new Error('permanent failure'));

    await enqueueManualFraudScan({ evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' });
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000);
    await vi.waitFor(() => expect(notifySuperAdmin).toHaveBeenCalled());

    expect(runDetection).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(notifySuperAdmin).toHaveBeenCalledWith('fraud:scan_failed', {
      job_name: 'manual_scan',
      error: 'permanent failure',
      attempts: 3,
    });
  });
});
