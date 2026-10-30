import type { PayrollPeriodType } from '@potato-corner/shared';

/**
 * POS-PERF-P52 — business dates and pay periods in the branch payroll
 * policy's timezone. Unlike lib/manila-time.ts (fixed +08:00), the zone here
 * is configurable, so offsets are read from Intl for the instant in question.
 * Date keys are 'YYYY-MM-DD' strings throughout.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (e.g. +8h for Asia/Manila). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = instant.getTime() - (instant.getTime() % 1000);
  return asUtc - wholeSecond;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Business date ('YYYY-MM-DD') an instant falls on in `timeZone`. */
export function businessDateKey(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC instant of local midnight starting business date `dateKey` in `timeZone`. */
export function startOfBusinessDate(dateKey: string, timeZone: string): Date {
  const [y, m, d] = [Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)), Number(dateKey.slice(8, 10))];
  const utcMidnight = Date.UTC(y, m - 1, d);
  let guess = utcMidnight - offsetMs(new Date(utcMidnight), timeZone);
  // Second pass settles zones whose offset differs between the two instants.
  const corrected = utcMidnight - offsetMs(new Date(guess), timeZone);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

/** Local wall-clock hour `hour` (0–24) on `dateKey`, as a UTC instant. */
export function businessTime(dateKey: string, hour: number, timeZone: string): Date {
  return new Date(startOfBusinessDate(dateKey, timeZone).getTime() + hour * 3_600_000);
}

export function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface PeriodRule {
  periodType: PayrollPeriodType;
  semiMonthlyFirstEndDay: number | null;
}

export interface PayPeriod {
  start: string;
  end: string;
}

/** The pay period (inclusive business dates) containing `dateKey`. */
export function periodContaining(dateKey: string, rule: PeriodRule): PayPeriod {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const prefix = `${year}-${pad(month)}`;
  const last = lastDayOfMonth(year, month);
  if (rule.periodType === 'monthly') {
    return { start: `${prefix}-01`, end: `${prefix}-${pad(last)}` };
  }
  // Checked by the DB constraint and Zod; the fallback only satisfies the type.
  const cutoff = rule.semiMonthlyFirstEndDay ?? 15;
  return day <= cutoff
    ? { start: `${prefix}-01`, end: `${prefix}-${pad(cutoff)}` }
    : { start: `${prefix}-${pad(cutoff + 1)}`, end: `${prefix}-${pad(last)}` };
}

export function isPolicyPeriod(period: PayPeriod, rule: PeriodRule): boolean {
  const expected = periodContaining(period.start, rule);
  return expected.start === period.start && expected.end === period.end;
}

/** The `count` periods ending with the one containing `todayKey`, newest first. */
export function recentPeriods(todayKey: string, rule: PeriodRule, count: number): PayPeriod[] {
  const periods: PayPeriod[] = [];
  let cursor = todayKey;
  for (let i = 0; i < count; i += 1) {
    const period = periodContaining(cursor, rule);
    periods.push(period);
    cursor = addDays(period.start, -1);
  }
  return periods;
}

export function periodsOverlap(a: PayPeriod, b: PayPeriod): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** "2026-10-15 22:05" in `timeZone` — display/export only. */
export function formatBusinessDateTime(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
