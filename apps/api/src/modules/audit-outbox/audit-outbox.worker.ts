import { auditOutboxService } from './audit-outbox.service.js';
import { AUDIT_OUTBOX_STALE_LOCK_MS, type AuditOutboxCycleResult } from './audit-outbox.types.js';

export interface AuditOutboxWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  staleLockMs?: number;
  /** Single cycle only: deliver just these groups. */
  groupIds?: string[];
}

const DEFAULT_BATCH_SIZE = 50;
// Audit entries aren't on any request's critical path; a few seconds' delay is fine.
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Single-cycle entry point — claims and delivers at most one batch, then returns. What tests and the recovery script call instead of the loop below. */
export function runAuditOutboxCycle(options: AuditOutboxWorkerOptions = {}): Promise<AuditOutboxCycleResult> {
  return auditOutboxService.runCycle(options.batchSize ?? DEFAULT_BATCH_SIZE, options.staleLockMs ?? AUDIT_OUTBOX_STALE_LOCK_MS, options.groupIds);
}

/**
 * POS-PERF-P38R4 — long-running poll loop, started unconditionally from
 * server.ts#start like the inventory deduction worker: an operation that
 * committed with pending audit intents must reach audit_logs with no
 * further client action and no dependency on Sentry. Every API instance
 * runs one; the claim token and the delivery guard make that safe.
 * `stop()` lets an in-flight cycle finish before the loop exits.
 */
export function createAuditOutboxWorker(options: AuditOutboxWorkerOptions = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleLockMs = options.staleLockMs ?? AUDIT_OUTBOX_STALE_LOCK_MS;

  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await auditOutboxService.runCycle(batchSize, staleLockMs);
      } catch (error) {
        // A whole-cycle failure (e.g. the database unreachable) must never
        // crash the API or end the loop. Claimed groups fall back to
        // stale-claim recovery.
        console.error('Audit outbox worker cycle failed:', error);
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return {
    start(): void {
      if (loopPromise) return;
      stopped = false;
      loopPromise = loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      await loopPromise;
      loopPromise = null;
    },
  };
}
