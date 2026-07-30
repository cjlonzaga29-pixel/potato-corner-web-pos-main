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
