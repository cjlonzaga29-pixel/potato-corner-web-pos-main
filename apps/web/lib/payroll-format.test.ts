import { describe, it, expect } from 'vitest';
import { formatPayrollDuration, formatPeso } from './payroll-format';

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
});
