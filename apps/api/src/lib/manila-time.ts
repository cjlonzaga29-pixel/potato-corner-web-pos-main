const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Canonical Asia/Manila calendar-day window helper. Postgres stores UTC
 * timestamps and the server may run in any TZ, so every module that needs
 * "today" in the Philippine business sense (dashboards, reports, fraud
 * rules, EOD summaries) must compute the window explicitly rather than
 * relying on server-local midnight — a naive `new Date(); setHours(0,0,0,0)`
 * is only correct when the process TZ happens to be Asia/Manila.
 *
 * Returns [Manila 00:00:00.000, Manila 23:59:59.999], expressed as UTC
 * instants for use in Prisma date-range filters.
 */
export function dayBounds(evaluationDate: Date): { dayStart: Date; dayEnd: Date } {
  const manilaTime = new Date(evaluationDate.getTime() + MANILA_OFFSET_MS);
  const manilaDayStartUtcMs =
    Date.UTC(manilaTime.getUTCFullYear(), manilaTime.getUTCMonth(), manilaTime.getUTCDate()) - MANILA_OFFSET_MS;
  return {
    dayStart: new Date(manilaDayStartUtcMs),
    dayEnd: new Date(manilaDayStartUtcMs + 24 * 60 * 60 * 1000 - 1),
  };
}

/**
 * The Manila calendar date (YYYY-MM-DD) a UTC instant falls on — same
 * offset arithmetic as dayBounds, so a transaction bucketed here always
 * agrees with the dayBounds() window it falls inside. Used anywhere a
 * business date needs to be a map/group-by key or a receipt-number date
 * prefix, rather than a query range (reports bucketing, EOD summaries,
 * fraud rules, receipt numbers) — never derive this with
 * `date.toISOString().slice(0, 10)`, which is the UTC calendar day and
 * can be off by one near Manila midnight.
 */
export function manilaDateKey(evaluationDate: Date): string {
  const manilaTime = new Date(evaluationDate.getTime() + MANILA_OFFSET_MS);
  const year = manilaTime.getUTCFullYear();
  const month = String(manilaTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(manilaTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Inverse of manilaDateKey: takes a Manila calendar date (YYYY-MM-DD, as
 * submitted by a date-only form field — e.g. expense incurred_at) and
 * returns the UTC instant of that date's Manila midnight, for storage in a
 * DateTime column. Never hand a bare "YYYY-MM-DD" straight to `new Date()`
 * for a business-date field — that's parsed as UTC midnight, not Manila
 * midnight, and silently drifts the stored date by 8 hours relative to
 * every other Manila-anchored read (dayBounds, manilaDateKey).
 */
export function manilaDateStringToUtc(dateStr: string): Date {
  // Fixed-width slicing (not split('-').map(Number)) so each piece is typed
  // as `string`, not `string | undefined`, under noUncheckedIndexedAccess —
  // dateStr is expected to already be a validated YYYY-MM-DD (z.iso.date()).
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day) - MANILA_OFFSET_MS);
}

/**
 * Resolves a date-range filter's `from`/`to` boundary to a UTC instant. A
 * bare "YYYY-MM-DD" value names a Philippine business day, not a UTC one —
 * `new Date(value)` would anchor it to Manila 8:00 AM (UTC midnight is 8
 * hours into the Manila day), silently dropping that morning's records on
 * the start boundary and cutting the end boundary off 8 hours early. Routing
 * it through dayBounds() (noon UTC is always still inside the same Manila
 * calendar date as the input, so it can't roll over) keeps every date-range
 * filter's day boundaries in agreement with the dashboard, EOD summary, and
 * fraud rules. A value that's already a precise ISO datetime (e.g. a
 * dashboard widget's "since browser-local start of day to now" window) is
 * used as-is — the caller already knows the exact instant it wants.
 *
 * Originally reports.router.ts's local toBoundaryDate; consolidated here so
 * every date-range filter (reports, expenses, transactions, audit log,
 * attendance, inventory movements, shadow-BOM) shares one implementation.
 */
export function resolveDateRangeBoundary(value: string, boundary: 'start' | 'end'): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const { dayStart, dayEnd } = dayBounds(new Date(`${value}T12:00:00.000Z`));
    return boundary === 'start' ? dayStart : dayEnd;
  }
  return new Date(value);
}

/**
 * Human-readable Manila-timezone date+time for printed reports (PDF), e.g.
 * "Aug 7, 2026, 2:34 PM" — explicit Asia/Manila zone so the server process's
 * own TZ never leaks in (same reasoning as dayBounds). Accepts the raw
 * `.toISOString()` strings report rows store for created_at/closed_at/etc —
 * display-only, doesn't touch the underlying stored value.
 */
export function formatManilaDateTime(value: string | Date): string {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(parsed);
}

/**
 * Same reasoning as dayBounds, for a Manila calendar month — used by
 * "this month" activity windows (e.g. employee monthly stats) that must
 * agree with dayBounds on where a Manila day starts.
 */
export function monthBounds(evaluationDate: Date): { monthStart: Date; monthEnd: Date } {
  const manilaTime = new Date(evaluationDate.getTime() + MANILA_OFFSET_MS);
  const manilaMonthStartUtcMs =
    Date.UTC(manilaTime.getUTCFullYear(), manilaTime.getUTCMonth(), 1) - MANILA_OFFSET_MS;
  const manilaMonthEndUtcMs =
    Date.UTC(manilaTime.getUTCFullYear(), manilaTime.getUTCMonth() + 1, 1) - MANILA_OFFSET_MS;
  return {
    monthStart: new Date(manilaMonthStartUtcMs),
    monthEnd: new Date(manilaMonthEndUtcMs - 1),
  };
}
