/**
 * POS-PERF-P52 — display helpers for payroll. Money arrives from the API as
 * decimal strings ("1234.50") and is only ever re-formatted as text here —
 * never parsed into a float — so what the screen shows is exactly what the
 * server stored.
 */

/** "1234567.5" | "-12.00" → "₱1,234,567.50" | "−₱12.00" */
export function formatPeso(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}₱${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** Exact milliseconds → "7h 59m" (seconds shown only when present, e.g. "7h 59m 31s"). */
export function formatPayrollDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${hours}h ${minutes}m`;
}

/** Wall-clock date and time in the payroll policy's timezone, 12-hour, e.g. "Oct 16, 8:00 AM". */
export function formatPayrollTime(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** Clock time only, 12-hour, e.g. "7:55 PM". */
export function formatPayrollClock(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: timeZone ?? 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
}

/** A recorded moment (calculated, finalized, paid…) with its date, 12-hour, e.g. "Oct 30, 2026, 8:00 AM". */
export function formatPayrollDateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function splitDateKey(key: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** A business date key ("2026-10-16") as text, with no timezone shift: "Oct 16, 2026". */
export function formatPayrollDate(key: string): string {
  const p = splitDateKey(key);
  if (!p) return key;
  return `${MONTHS[p.m - 1] ?? ''} ${p.d}, ${p.y}`;
}

/** A pay period from its date keys: "Oct 16–31, 2026", "Oct 16 – Nov 15, 2026" or "Dec 16, 2026 – Jan 15, 2027". */
export function formatPayrollPeriod(start: string, end: string): string {
  const a = splitDateKey(start);
  const b = splitDateKey(end);
  if (!a || !b) return `${start} to ${end}`;
  if (a.y !== b.y) return `${formatPayrollDate(start)} – ${formatPayrollDate(end)}`;
  if (a.m !== b.m) return `${MONTHS[a.m - 1] ?? ''} ${a.d} – ${MONTHS[b.m - 1] ?? ''} ${b.d}, ${b.y}`;
  return `${MONTHS[a.m - 1] ?? ''} ${a.d}–${b.d}, ${b.y}`;
}

export const BREAK_TREATMENT_LABELS = {
  paid: 'Breaks are paid',
  unpaid: 'Breaks are unpaid',
  paid_up_to_limit: 'Paid up to a limit per shift',
} as const;

/** Plain description of a saved pay-period scheme. */
export function describePayPeriod(periodType: 'monthly' | 'semi_monthly', firstEndDay: number | null): string {
  if (periodType === 'monthly') return 'Monthly';
  return firstEndDay ? `Semi-monthly: 1–${firstEndDay} and ${firstEndDay + 1}–end of month` : 'Semi-monthly';
}

export const RUN_STATUS_LABELS = {
  draft: 'Draft — not finalized',
  finalized: 'Finalized',
  superseded: 'Superseded by a revision',
  discarded: 'Discarded draft',
} as const;

export const ADJUSTMENT_CATEGORY_LABELS: Record<string, string> = {
  allowance: 'Allowance',
  bonus: 'Bonus',
  other_earning: 'Other earning',
  documented_deduction: 'Documented deduction',
};

/** Common choices offered in the timezone picker; the API accepts any valid IANA zone. */
export const PAYROLL_TIMEZONE_SUGGESTIONS = ['Asia/Manila', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'UTC'] as const;
