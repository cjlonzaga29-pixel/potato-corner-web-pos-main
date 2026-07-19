import { scheduleDaily } from '../lib/daily-scheduler.js';
import { runWithRetry } from '../lib/job-runner.js';
import { buildEodSummary } from '../modules/reports/eod-summary.service.js';
import { enqueueNotification } from './notification.queue.js';

/**
 * Phase 21: BullMQ (including its `repeat: { pattern: cron, tz }`
 * registration) removed — see lib/job-runner.ts and lib/daily-scheduler.ts
 * for the design notes. Same retry policy as fraud.queue.ts / inventory.queue.ts (Phase 18 Decision 7).
 */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/** 23:59 Asia/Manila — one minute after the fraud scan's 23:00 slot (see fraud.queue.ts), so "open fraud alerts created that day" reflects that night's fraud run. */
const NIGHTLY_EOD_HOUR = 23;
const NIGHTLY_EOD_MINUTE = 59;
const NIGHTLY_TIMEZONE = 'Asia/Manila';

/**
 * Registers the nightly EOD summary. setTimeout-based (see scheduleDaily) —
 * process-lifetime only, unlike BullMQ's Redis-persisted repeatable job.
 * Calling this on every process boot is still idempotent (each call just
 * arms its own independent daily timer for the same wall-clock slot).
 */
export function scheduleNightlyEodSummary(): Promise<void> {
  scheduleDaily(NIGHTLY_EOD_HOUR, NIGHTLY_EOD_MINUTE, NIGHTLY_TIMEZONE, async () => {
    try {
      await runWithRetry(() => runNightlyEodSummary(), RETRY_DELAYS_MS);
    } catch (error) {
      // Only reached once every retry attempt has failed.
      console.error(`EOD summary job permanently failed after ${MAX_ATTEMPTS} attempts:`, error);
    }
  });
  return Promise.resolve();
}

async function runNightlyEodSummary(): Promise<void> {
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
}
