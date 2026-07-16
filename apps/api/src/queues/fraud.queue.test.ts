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

vi.mock('../modules/fraud/detection.service.js', () => ({
  runDetection: vi.fn(),
}));

vi.mock('../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

const { runDetection } = await import('../modules/fraud/detection.service.js');
const { notifySuperAdmin } = await import('../lib/notify.js');
const Sentry = await import('@sentry/node');
const { fraudWorker, scheduleNightlyFraudScan, enqueueManualFraudScan } = await import('./fraud.queue.js');

// Captured once, right after import — fraudWorker.on('failed', ...) is called
// exactly once at module load, and beforeEach's clearAllMocks() below would
// otherwise erase that call record before the "failed handler" tests run.
const registeredFailedCall = onMock.mock.calls.find((call) => call[0] === 'failed');
const failedHandler = registeredFailedCall?.[1] as (job: Job | undefined, error: Error) => void;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scheduleNightlyFraudScan', () => {
  it('registers a repeatable nightly_scan job at 23:00 Asia/Manila with a fixed jobId', async () => {
    await scheduleNightlyFraudScan();

    expect(addMock).toHaveBeenCalledWith(
      'nightly_scan',
      {},
      {
        repeat: { pattern: '0 23 * * *', tz: 'Asia/Manila' },
        jobId: 'fraud-nightly-scan',
        attempts: 3,
        backoff: { type: 'custom' },
      },
    );
  });
});

describe('enqueueManualFraudScan', () => {
  it('enqueues a manual_scan job with the given evaluationDate and requestedBy', async () => {
    await enqueueManualFraudScan({ evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' });

    expect(addMock).toHaveBeenCalledWith(
      'manual_scan',
      { evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' },
      { attempts: 3, backoff: { type: 'custom' } },
    );
  });
});

describe('fraudWorker processor', () => {
  it('calls runDetection for a nightly_scan job', async () => {
    vi.mocked(runDetection).mockResolvedValue({ branchesEvaluated: 3, rulesEvaluated: 7, alertsCreated: 1, alertsSkippedDupe: 0 });
    const processor = (fraudWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;

    await processor({ name: 'nightly_scan', data: {} } as Job);

    expect(runDetection).toHaveBeenCalledWith(expect.any(Date));
  });

  it('calls runDetection with the job-provided evaluationDate for a manual_scan job', async () => {
    vi.mocked(runDetection).mockResolvedValue({ branchesEvaluated: 1, rulesEvaluated: 7, alertsCreated: 0, alertsSkippedDupe: 0 });
    const processor = (fraudWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;

    await processor({ name: 'manual_scan', data: { evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' } } as Job);

    expect(runDetection).toHaveBeenCalledWith(new Date('2026-07-17T00:00:00.000Z'));
  });
});

describe('fraudWorker failed handler', () => {
  it('registers an "failed" listener on construction', () => {
    expect(registeredFailedCall).toEqual(['failed', expect.any(Function)]);
  });

  it('reports to Sentry and notifies Super Admin only after the final attempt', () => {
    const job = { name: 'nightly_scan', attemptsMade: 3, opts: { attempts: 3 } } as unknown as Job;

    failedHandler(job, new Error('Redis unreachable'));

    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(notifySuperAdmin).toHaveBeenCalledWith('fraud:scan_failed', {
      job_name: 'nightly_scan',
      error: 'Redis unreachable',
      attempts: 3,
    });
  });

  it('does nothing before the final attempt', () => {
    const job = { name: 'nightly_scan', attemptsMade: 1, opts: { attempts: 3 } } as unknown as Job;

    failedHandler(job, new Error('transient'));

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
  });
});
