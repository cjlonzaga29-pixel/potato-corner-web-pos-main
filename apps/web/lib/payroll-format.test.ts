import { describe, it, expect } from 'vitest';
import { formatPayrollClock, formatPayrollDate, formatPayrollDateTime, formatPayrollDuration, formatPayrollPeriod, formatPayrollTime, formatPeso } from './payroll-format';

describe('payroll formatting', () => {
  it('formats peso strings as text, never via floating point', () => {
    expect(formatPeso('1234567.5')).toBe('₱1,234,567.50');
    expect(formatPeso('0.10')).toBe('₱0.10');
    expect(formatPeso('-12.00')).toBe('−₱12.00');
    // A float round-trip would print 9007199254740993 as …992.
    expect(formatPeso('9007199254740993.01')).toBe('₱9,007,199,254,740,993.01');
    expect(formatPeso(null)).toBe('—');
  });

  it('formats exact durations', () => {
    expect(formatPayrollDuration(8 * 3_600_000)).toBe('8h 0m');
    expect(formatPayrollDuration(7 * 3_600_000 + 59 * 60_000 + 31_000)).toBe('7h 59m 31s');
  });

  it('shows clock times in 12-hour form in the policy timezone', () => {
    expect(formatPayrollTime('2026-10-16T11:55:00.000Z', 'Asia/Manila')).toBe('Oct 16, 7:55 PM');
    expect(formatPayrollClock('2026-10-16T00:05:00.000Z', 'Asia/Manila')).toBe('8:05 AM');
    expect(formatPayrollDateTime('2026-10-30T11:55:00.000Z')).toBe('Oct 30, 2026, 7:55 PM');
  });

  it('formats business dates and pay periods without a timezone shift', () => {
    expect(formatPayrollDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatPayrollPeriod('2026-10-16', '2026-10-31')).toBe('Oct 16–31, 2026');
    expect(formatPayrollPeriod('2026-10-16', '2026-11-15')).toBe('Oct 16 – Nov 15, 2026');
    expect(formatPayrollPeriod('2026-12-16', '2027-01-15')).toBe('Dec 16, 2026 – Jan 15, 2027');
  });
});
