/**
 * Phase 21: replaces BullMQ's `repeat: { pattern: cron, tz }` registration
 * (used by the nightly fraud scan and EOD summary) now that there's no
 * queue to hold a repeatable job definition. Re-derives "ms until the next
 * HH:mm in `timeZone`" on every run and re-arms itself with setTimeout —
 * process-lifetime only, not persisted, so a run scheduled during downtime
 * is simply skipped rather than caught up on restart.
 */

function zonedWallClockMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  // Treats the zoned wall-clock fields as if they were UTC — a standard
  // trick for computing elapsed wall-clock time in an arbitrary zone
  // without a timezone database dependency.
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

export function msUntilNextOccurrence(hour: number, minute: number, timeZone: string, now: Date = new Date()): number {
  const wallNowMs = zonedWallClockMs(now, timeZone);
  const wallNow = new Date(wallNowMs);
  let target = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate(), hour, minute, 0);
  if (target <= wallNowMs) target += 24 * 60 * 60 * 1000;
  return target - wallNowMs;
}

export function scheduleDaily(hour: number, minute: number, timeZone: string, task: () => Promise<void>): void {
  const run = (): void => {
    void task().catch((error: unknown) => console.error('Scheduled daily job failed:', error));
    setTimeout(run, msUntilNextOccurrence(hour, minute, timeZone));
  };
  setTimeout(run, msUntilNextOccurrence(hour, minute, timeZone));
}

/** Fixed-interval counterpart to scheduleDaily, for jobs that don't need wall-clock alignment (e.g. cache pruning). */
export function scheduleEvery(intervalMs: number, task: () => Promise<void>): void {
  setInterval(() => {
    void task().catch((error: unknown) => console.error('Scheduled interval job failed:', error));
  }, intervalMs);
}
