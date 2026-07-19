import * as Sentry from '@sentry/node';
import { randomUUID } from 'node:crypto';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { runFireAndForget, runWithRetry } from '../lib/job-runner.js';
import { scheduleDaily } from '../lib/daily-scheduler.js';
import { notifySuperAdmin } from '../lib/notify.js';
import { runDetection } from '../modules/fraud/detection.service.js';

/**
 * Phase 21: BullMQ (including its `repeat: { pattern: cron, tz }`
 * registration) removed — see lib/job-runner.ts and lib/daily-scheduler.ts
 * for the design notes. Architecture doc §3.6 retry policy (10s/60s/300s,
 * same schedule as inventory.queue.ts and report.queue.ts) preserved via
 * runWithRetry for the manual-scan path.
 */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/** 23:00 Asia/Manila — deliberately before the Phase 18 EOD summary's 23:59 slot (Architecture doc Part 13), so "open fraud alerts created that day" has this run's output available. */
const NIGHTLY_SCAN_HOUR = 23;
const NIGHTLY_SCAN_MINUTE = 0;
const NIGHTLY_TIMEZONE = 'Asia/Manila';

export interface ManualScanJobData {
  evaluationDate: string;
  requestedBy: string;
}

/**
 * Registers the nightly fraud scan. setTimeout-based (see scheduleDaily) —
 * process-lifetime only, unlike BullMQ's Redis-persisted repeatable job.
 * Calling this on every process boot is still idempotent (each call just
 * arms its own independent daily timer for the same wall-clock slot).
 */
export function scheduleNightlyFraudScan(): Promise<void> {
  scheduleDaily(NIGHTLY_SCAN_HOUR, NIGHTLY_SCAN_MINUTE, NIGHTLY_TIMEZONE, async () => {
    try {
      await runWithRetry(() => runNightlyScan(), RETRY_DELAYS_MS);
    } catch (error) {
      // Only reached once every retry attempt has failed — matches the old
      // fraudWorker.on('failed', ...) handler firing on final failure only.
      handleFraudJobFailure('nightly_scan', error, MAX_ATTEMPTS);
    }
  });
  return Promise.resolve();
}

async function runNightlyScan(): Promise<void> {
  const result = await runDetection(new Date());
  console.log(`Nightly fraud scan complete: ${JSON.stringify(result)}`);
}

/** Enqueued by fraudService.triggerManualScan (Task 8's Super-Admin-only POST /api/fraud/run). Runs in the background; returns immediately with a generated id for audit-log correlation (the old BullMQ job id served the same purpose). */
export function enqueueManualFraudScan(data: ManualScanJobData): Promise<{ id: string }> {
  const jobId = randomUUID();
  runFireAndForget(
    () => runWithRetry(() => processManualFraudScan(data), RETRY_DELAYS_MS),
    (error) => handleFraudJobFailure('manual_scan', error, MAX_ATTEMPTS),
  );
  return Promise.resolve({ id: jobId });
}

async function processManualFraudScan(data: ManualScanJobData): Promise<void> {
  const result = await runDetection(new Date(data.evaluationDate));
  console.log(`Manual fraud scan complete: ${JSON.stringify(result)}`);
}

/** After the final retry attempt, report to Sentry and notify Super Admins — mirrors the old fraudWorker.on('failed', ...) handler. */
function handleFraudJobFailure(jobName: string, error: unknown, attemptsMade: number): void {
  const message = error instanceof Error ? error.message : String(error);
  Sentry.captureException(error);
  console.error(`Fraud detection job "${jobName}" permanently failed after ${attemptsMade} attempts:`, message);
  notifySuperAdmin(SOCKET_EVENTS.FRAUD_SCAN_FAILED, {
    job_name: jobName,
    error: message,
    attempts: attemptsMade,
  });
}
