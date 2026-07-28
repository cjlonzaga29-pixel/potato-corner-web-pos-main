/**
 * CR-010A.2 — shared constants for the outbox projection consumer. Same
 * retry cadence (10s / 60s / 300s, 3 attempts) already used by every queue
 * in src/queues/ via RETRY_DELAYS_MS, reused here for consistency rather
 * than inventing a second schedule.
 */
export const PROJECTION_RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
export const PROJECTION_MAX_ATTEMPTS = PROJECTION_RETRY_DELAYS_MS.length;

/** A `processing` lock older than this is assumed to belong to a dead/crashed worker and is eligible for re-claim. */
export const PROJECTION_STALE_LOCK_MS = 5 * 60_000;

/**
 * CR-010A.2A — how long a `deferred` row (missing/unresolved mapping) waits
 * before it becomes eligible for another claim attempt. Without this, a row
 * deferred every cycle would be reclaimed on every poll, burning a claim +
 * mapping lookup for no new information.
 */
export const PROJECTION_DEFERRED_RETRY_DELAY_MS = 60_000;

export interface ProjectionCycleResult {
  claimed: number;
  processed: number;
  deferred: number;
  retried: number;
  stuck: number;
}
