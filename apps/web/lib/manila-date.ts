/**
 * Manila calendar-date helpers for web date-picker/report/export defaults
 * and offline receipt numbering. A browser's local clock is not guaranteed
 * to be set to Asia/Manila, so `new Date().toISOString().slice(0, 10)`
 * (UTC) or `new Date().toLocaleDateString()` (device-local timezone) can
 * both show the wrong calendar day for a Philippine business form or
 * receipt. Every "today" or "N days ago" default a user sees, and every
 * offline receipt-number date segment, must be computed against
 * Asia/Manila explicitly instead — this is the single place that does it,
 * mirroring apps/api/src/lib/manila-time.ts's reasoning on the API side.
 */
const MANILA_TIME_ZONE = 'Asia/Manila';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const manilaDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: MANILA_TIME_ZONE });

/** YYYY-MM-DD for `date` in Asia/Manila local time, not UTC. */
export function manilaDateString(date: Date): string {
  return manilaDateFormatter.format(date);
}

/** Today's date in Asia/Manila, as YYYY-MM-DD. */
export function manilaToday(): string {
  return manilaDateString(new Date());
}

/** The Asia/Manila calendar date `days` days before now, as YYYY-MM-DD. */
export function manilaDaysAgo(days: number): string {
  return manilaDateString(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

/** The first day of the current Asia/Manila calendar month, as YYYY-MM-DD. */
export function manilaMonthStart(): string {
  return `${manilaToday().slice(0, 7)}-01`;
}

/**
 * Start of `dateStr`'s Asia/Manila calendar day, as a UTC ISO instant.
 * Mirrors apps/api/src/lib/manila-time.ts's resolveDateRangeBoundary('start')
 * so a client-computed boundary (needed by endpoints that require a precise
 * instant rather than a bare date) agrees with the server's canonical Manila
 * day window regardless of the browser's local timezone.
 */
export function manilaStartOfDayISO(dateStr: string): string {
  const utcMidnightMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return new Date(utcMidnightMs - MANILA_OFFSET_MS).toISOString();
}

/** End of `dateStr`'s Asia/Manila calendar day, as a UTC ISO instant — see manilaStartOfDayISO. */
export function manilaEndOfDayISO(dateStr: string): string {
  const utcMidnightMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return new Date(utcMidnightMs - MANILA_OFFSET_MS + 24 * 60 * 60 * 1000 - 1).toISOString();
}
