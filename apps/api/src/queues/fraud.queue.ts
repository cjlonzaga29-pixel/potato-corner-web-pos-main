import { Queue, Worker, type Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { notifySuperAdmin } from '../lib/notify.js';
import { runDetection } from '../modules/fraud/detection.service.js';

/** Architecture doc §3.6 retry policy, same 10s/60s/300s schedule as inventory.queue.ts and report.queue.ts. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * 23:00 Asia/Manila — deliberately before the Phase 18 EOD summary's 23:59
 * slot (Architecture doc Part 13), so "open fraud alerts created that day"
 * has this run's output available. jobId is fixed so BullMQ dedupes the
 * repeatable registration itself; calling scheduleNightlyFraudScan() on
 * every process boot is idempotent, not a duplicate schedule.
 */
const NIGHTLY_SCAN_JOB_ID = 'fraud-nightly-scan';
const NIGHTLY_CRON_PATTERN = '0 23 * * *';
const NIGHTLY_TIMEZONE = 'Asia/Manila';

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

export interface ManualScanJobData {
  evaluationDate: string;
  requestedBy: string;
}

export const fraudQueue = new Queue('fraud', { connection: redis });

/** Registers the codebase's first repeatable BullMQ job. See Corrections #2 — there is no prior in-repo pattern for this. */
export function scheduleNightlyFraudScan(): Promise<Job> {
  return fraudQueue.add(
    'nightly_scan',
    {},
    {
      repeat: { pattern: NIGHTLY_CRON_PATTERN, tz: NIGHTLY_TIMEZONE },
      jobId: NIGHTLY_SCAN_JOB_ID,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'custom' },
    },
  );
}

/** Enqueued by fraudService.triggerManualScan (Task 8's Super-Admin-only POST /api/fraud/run). */
export function enqueueManualFraudScan(data: ManualScanJobData): Promise<Job> {
  return fraudQueue.add('manual_scan', data, { attempts: MAX_ATTEMPTS, backoff: { type: 'custom' } });
}

export const fraudWorker = new Worker(
  'fraud',
  async (job: Job) => {
    if (job.name === 'nightly_scan') {
      const result = await runDetection(new Date());
      console.log(`Nightly fraud scan complete: ${JSON.stringify(result)}`);
      return;
    }
    if (job.name === 'manual_scan') {
      const { evaluationDate } = job.data as ManualScanJobData;
      const result = await runDetection(new Date(evaluationDate));
      console.log(`Manual fraud scan complete: ${JSON.stringify(result)}`);
      return;
    }
  },
  { connection: createWorkerConnection(), settings: { backoffStrategy: retryDelayMs } },
);

/** After the final retry attempt, report to Sentry and notify Super Admins — mirrors inventoryWorker.on('failed', ...). */
fraudWorker.on('failed', (job, error) => {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? MAX_ATTEMPTS)) return;

  Sentry.captureException(error);
  console.error(`Fraud detection job "${job.name}" permanently failed after ${job.attemptsMade} attempts:`, error.message);
  notifySuperAdmin(SOCKET_EVENTS.FRAUD_SCAN_FAILED, {
    job_name: job.name,
    error: error.message,
    attempts: job.attemptsMade,
  });
});
