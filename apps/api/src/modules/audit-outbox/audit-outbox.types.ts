import type { AuditLogEntry } from '../../middleware/audit-log.js';

/**
 * POS-PERF-P38R4 — durable audit outbox constants.
 *
 * Longer than the 10s / 60s / 300s queue cadence (inventory deduction,
 * projection): those retry work whose effect is visible elsewhere, but an
 * audit entry that exhausts its attempts only waits for a person to notice.
 * Five backoffs (about 50 minutes in all) ride out a database blip or a
 * deploy before a group is marked `stuck`.
 */
export const AUDIT_OUTBOX_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 1_800_000];
export const AUDIT_OUTBOX_MAX_ATTEMPTS = AUDIT_OUTBOX_RETRY_DELAYS_MS.length + 1;

/** A `processing` claim older than this belongs to a crashed or stalled worker and may be re-claimed. Well past the delivery transaction's own timeout. */
export const AUDIT_OUTBOX_STALE_LOCK_MS = 5 * 60_000;

/** One audit event to persist with the change it describes. `ipAddress` is the request's, as on every other audit entry; no credentials or other request data. */
export type AuditIntent = Omit<AuditLogEntry, 'userAgent'>;

export interface AuditOutboxCycleResult {
  /** Groups (originating operations) claimed this cycle. */
  claimed: number;
  delivered: number;
  retried: number;
  stuck: number;
  /** Claim lost to a stale-claim recovery before delivery: nothing was written by this worker. */
  skipped: number;
}
