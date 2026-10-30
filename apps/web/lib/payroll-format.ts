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

/** Wall-clock time in the payroll policy's timezone, e.g. "Oct 16, 08:00". */
export function formatPayrollTime(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: timeZone ?? 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export const BREAK_TREATMENT_LABELS = {
  paid: 'Breaks are paid',
  unpaid: 'Breaks are unpaid',
  paid_up_to_limit: 'Paid up to a limit per shift',
} as const;

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
