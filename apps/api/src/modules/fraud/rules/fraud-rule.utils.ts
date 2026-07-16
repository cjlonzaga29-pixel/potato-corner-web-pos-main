const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The nightly job fires at 23:00 Asia/Manila (15:00 UTC); Postgres stores
 * UTC timestamps. A naive UTC-midnight window would be 8 hours off from the
 * branch's actual business day, so this computes the Manila calendar-day
 * window explicitly: [Manila 00:00:00.000, Manila 23:59:59.999], expressed
 * as UTC instants for use in Prisma date-range filters.
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
