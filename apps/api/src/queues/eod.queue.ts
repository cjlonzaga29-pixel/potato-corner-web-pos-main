import { Queue, Worker, type Job } from 'bullmq';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { buildEodSummary } from '../modules/reports/eod-summary.service.js';
import { enqueueNotification } from './notification.queue.js';

/** Same retry policy as fraud.queue.ts / inventory.queue.ts (Phase 18 Decision 7). */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * 23:59 Asia/Manila — one minute after the fraud scan's 23:00 slot (see
 * fraud.queue.ts), so "open fraud alerts created that day" reflects that
 * night's fraud run. A separate queue/worker rather than folding this into
 * notification.queue.ts's one-shot-job pattern, mirroring fraud.queue.ts's
 * own file shape for its repeatable job.
 */
const NIGHTLY_EOD_JOB_ID = 'eod-nightly-summary';
const NIGHTLY_CRON_PATTERN = '59 23 * * *';
const NIGHTLY_TIMEZONE = 'Asia/Manila';

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

export const eodQueue = new Queue('eod', { connection: redis });

/** Registers the nightly EOD summary job. Idempotent — jobId dedupes the repeatable registration across process boots. */
export function scheduleNightlyEodSummary(): Promise<Job> {
  return eodQueue.add(
    'nightly_eod_summary',
    {},
    {
      repeat: { pattern: NIGHTLY_CRON_PATTERN, tz: NIGHTLY_TIMEZONE },
      jobId: NIGHTLY_EOD_JOB_ID,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'custom' },
    },
  );
}

export const eodWorker = new Worker(
  'eod',
  async (job: Job) => {
    if (job.name === 'nightly_eod_summary') {
      const summary = await buildEodSummary(new Date());
      await Promise.all(
        summary.branchRevenue.map((branch) =>
          enqueueNotification('eod_summary', {
            type: 'eod_summary',
            branchId: branch.branchId,
            businessDate: summary.evaluationDate,
            totalSales: branch.revenue,
            totalRevenue: summary.totalRevenue,
            transactionCount: summary.transactionCount,
            voidCount: summary.voidCount,
            unresolvedCashVarianceCount: summary.unresolvedCashVarianceCount,
            openFraudAlertsCreatedTodayCount: summary.openFraudAlertsCreatedTodayCount,
            branchRevenue: summary.branchRevenue,
          }),
        ),
      );
      return;
    }
  },
  { connection: createWorkerConnection(), settings: { backoffStrategy: retryDelayMs } },
);
