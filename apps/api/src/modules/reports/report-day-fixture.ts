import { dayBounds, manilaDateKey } from '../../lib/manila-time.js';

/**
 * Test-only: fixture timestamps for report tests that filter on one Manila
 * report day. A fixture written as `now - 1h` lands on the previous Manila day
 * in the first hour after midnight, and one written as `new Date()` later in a
 * run can land on the next day after 11:59 PM. Every time-sensitive fixture is
 * built from one base instant and kept inside that base's Manila day.
 * Pure: takes the base explicitly, never reads or freezes the process clock.
 */
export function manilaReportDay(base: Date): { day: string; dayStart: Date; dayEnd: Date } {
  return { day: manilaDateKey(base), ...dayBounds(base) };
}

/** `candidate`, moved to the nearest edge of `base`'s Manila day when it falls outside it. */
export function clampToManilaReportDay(candidate: Date, base: Date): Date {
  const { dayStart, dayEnd } = dayBounds(base);
  return new Date(Math.min(Math.max(candidate.getTime(), dayStart.getTime()), dayEnd.getTime()));
}
