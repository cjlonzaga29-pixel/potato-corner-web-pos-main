import { describe, it, expect } from 'vitest';
import { calculatePayroll, periodWindow, type CalcInput, type CalcRecord } from './payroll-calc.js';
import {
  centavoMs,
  centavoMsToCentavos,
  divRoundHalfUp,
  formatCentavos,
  msToMinutesText,
  parsePesoToCentavos,
  perMinuteDisplay,
} from './payroll-money.js';
import { businessDateKey, isPolicyPeriod, periodContaining, recentPeriods, startOfBusinessDate } from './payroll-time.js';

const TZ = 'Asia/Manila';
const H = 3_600_000;
const M = 60_000;

/** Manila wall-clock → Date ("2026-10-01 08:00" = 2026-10-01T00:00Z). */
function mnl(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+08:00`);
}

let seq = 0;
function rec(partial: Partial<CalcRecord> & { clockIn: Date; clockOut: Date | null }): CalcRecord {
  seq += 1;
  return {
    id: partial.id ?? `rec-${seq}`,
    employeeId: partial.employeeId ?? 'emp-a',
    branchId: 'branch-1',
    breakMinutes: 0,
    breaks: [],
    originalRecordId: null,
    correctedByName: null,
    correctionReason: null,
    ...partial,
  };
}

function input(overrides: Partial<CalcInput> = {}): CalcInput {
  return {
    policy: { version: 1, timezone: TZ, breakTreatment: 'unpaid', paidBreakLimitMinutes: null },
    periodStart: '2026-10-01',
    periodEnd: '2026-10-15',
    regularShiftMinutes: 480,
    records: [],
    otherRecords: [],
    employees: new Map([
      ['emp-a', { id: 'emp-a', name: 'Ana Reyes', employeeCode: 'E-1', role: 'staff', assignments: [{ assignedAt: new Date('2026-01-01T00:00:00Z'), removedAt: null }] }],
      ['emp-b', { id: 'emp-b', name: 'Ben Cruz', employeeCode: 'E-2', role: 'staff', assignments: [{ assignedAt: new Date('2026-01-01T00:00:00Z'), removedAt: null }] }],
    ]),
    rates: [{ id: 'rate-a1', employeeId: 'emp-a', effectiveFrom: '2026-01-01', hourlyRate: '80.00' }],
    adjustments: [],
    resolutions: [],
    previousTotals: null,
    periodMatchesPolicy: true,
    ...overrides,
  };
}

describe('payroll money (exact integer arithmetic)', () => {
  it('parses and formats peso amounts without floating point', () => {
    expect(parsePesoToCentavos('75')).toBe(7500n);
    expect(parsePesoToCentavos('75.5')).toBe(7550n);
    expect(parsePesoToCentavos('0.01')).toBe(1n);
    expect(formatCentavos(123456n)).toBe('1234.56');
    expect(formatCentavos(-5n)).toBe('-0.05');
  });

  it('rounds half up exactly once', () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(15n, 10n)).toBe(2n);
    // 0.1 + 0.2 style accumulation: 3 × (1/3 hour at 1.00/h) is exactly 1.00, not 0.99.
    const third = centavoMs(100n, H / 3);
    expect(centavoMsToCentavos(third + third + third)).toBe(100n);
  });

  it('derives the per-minute display from the hourly rate only', () => {
    expect(perMinuteDisplay(7550n)).toBe('1.2583');
    expect(perMinuteDisplay(6000n)).toBe('1.0000');
    expect(msToMinutesText(29 * M + 31_000)).toBe('29.52');
  });
});

describe('payroll periods and business dates', () => {
  const semi = { periodType: 'semi_monthly' as const, semiMonthlyFirstEndDay: 15 };
  it('builds semi-monthly and monthly periods, including February and leap years', () => {
    expect(periodContaining('2026-10-15', semi)).toEqual({ start: '2026-10-01', end: '2026-10-15' });
    expect(periodContaining('2026-10-16', semi)).toEqual({ start: '2026-10-16', end: '2026-10-31' });
    expect(periodContaining('2026-02-20', semi)).toEqual({ start: '2026-02-16', end: '2026-02-28' });
    expect(periodContaining('2028-02-20', semi)).toEqual({ start: '2028-02-16', end: '2028-02-29' });
    expect(periodContaining('2026-11-30', { periodType: 'monthly', semiMonthlyFirstEndDay: null })).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(isPolicyPeriod({ start: '2026-10-01', end: '2026-10-15' }, semi)).toBe(true);
    expect(isPolicyPeriod({ start: '2026-10-01', end: '2026-10-31' }, semi)).toBe(false);
    expect(recentPeriods('2026-10-20', semi, 3).map((p) => p.start)).toEqual(['2026-10-16', '2026-10-01', '2026-09-16']);
  });

  it('uses the policy timezone for business dates and period windows', () => {
    // 2026-10-15 23:30 Manila is still the 15th there, but already the 15th 15:30 UTC.
    expect(businessDateKey(mnl('2026-10-15 23:30'), TZ)).toBe('2026-10-15');
    expect(businessDateKey(mnl('2026-10-16 00:30'), TZ)).toBe('2026-10-16');
    expect(businessDateKey(mnl('2026-10-16 00:30'), 'UTC')).toBe('2026-10-15');
    expect(startOfBusinessDate('2026-10-01', TZ).toISOString()).toBe('2026-09-30T16:00:00.000Z');
    const w = periodWindow('2026-10-01', '2026-10-15', TZ);
    expect(w.from.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-15T16:00:00.000Z');
    // A zone with DST still lands on local midnight.
    expect(startOfBusinessDate('2026-07-01', 'America/New_York').toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });
});

describe('calculatePayroll', () => {
  it('pays a plain shift at the hourly rate', () => {
    const r = calculatePayroll(input({ records: [rec({ clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 16:00') })] }));
    expect(r.employees[0]?.payable_ms).toBe(8 * H);
    expect(r.employees[0]?.basic_pay).toBe('640.00');
    expect(r.canFinalize).toBe(true);
  });

  it('subtracts unpaid break intervals and ignores the stored break_minutes for the same breaks', () => {
    const record = rec({
      clockIn: mnl('2026-10-02 08:00'),
      clockOut: mnl('2026-10-02 17:00'),
      breakMinutes: 60, // P51 stores Σ intervals here too — must not be subtracted again
      breaks: [{ id: 'b1', startedAt: mnl('2026-10-02 12:00'), endedAt: mnl('2026-10-02 13:00') }],
    });
    const r = calculatePayroll(input({ records: [record] }));
    const shift = r.employees[0]?.shifts[0];
    expect(shift?.break_source).toBe('intervals');
    expect(shift?.span_ms).toBe(9 * H);
    expect(shift?.unpaid_break_ms).toBe(H);
    expect(shift?.payable_ms).toBe(8 * H);
    expect(r.issues.some((i) => i.code === 'LEGACY_BREAK_TOTAL')).toBe(false);
  });

  it('pays breaks when the policy says paid, and pays the first N minutes under paid_up_to_limit', () => {
    const breaks = [
      { id: 'b1', startedAt: mnl('2026-10-02 10:00'), endedAt: mnl('2026-10-02 10:20') },
      { id: 'b2', startedAt: mnl('2026-10-02 12:00'), endedAt: mnl('2026-10-02 12:40') },
    ];
    const record = rec({ clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 17:00'), breakMinutes: 60, breaks });
    const paid = calculatePayroll(input({ policy: { version: 1, timezone: TZ, breakTreatment: 'paid', paidBreakLimitMinutes: null }, records: [record] }));
    expect(paid.employees[0]?.payable_ms).toBe(9 * H);
    const limited = calculatePayroll(input({ policy: { version: 1, timezone: TZ, breakTreatment: 'paid_up_to_limit', paidBreakLimitMinutes: 30 }, records: [record] }));
    const s = limited.employees[0]?.shifts[0];
    // 20 min (all of b1) + 10 min of b2 paid; 30 min of b2 unpaid.
    expect(s?.breaks.map((b) => [b.paid_minutes, b.unpaid_minutes])).toEqual([
      ['20.00', '0.00'],
      ['10.00', '30.00'],
    ]);
    expect(s?.payable_ms).toBe(9 * H - 30 * M);
  });

  it('falls back to legacy break_minutes only when there are no intervals, and flags it', () => {
    const record = rec({ clockIn: mnl('2026-10-03 08:00'), clockOut: mnl('2026-10-03 17:00'), breakMinutes: 60 });
    const r = calculatePayroll(input({ records: [record] }));
    expect(r.employees[0]?.shifts[0]?.break_source).toBe('legacy_total');
    expect(r.employees[0]?.payable_ms).toBe(8 * H);
    expect(r.issues.find((i) => i.code === 'LEGACY_BREAK_TOTAL')?.severity).toBe('warning');
    expect(r.canFinalize).toBe(true);
  });

  it('splits at an effective-dated rate change, including inside an overnight shift', () => {
    const rates = [
      { id: 'old', employeeId: 'emp-a', effectiveFrom: '2026-01-01', hourlyRate: '80.00' },
      { id: 'new', employeeId: 'emp-a', effectiveFrom: '2026-10-08', hourlyRate: '90.00' },
    ];
    const records = [
      rec({ clockIn: mnl('2026-10-05 08:00'), clockOut: mnl('2026-10-05 12:00') }), // 4h @80
      rec({ clockIn: mnl('2026-10-07 22:00'), clockOut: mnl('2026-10-08 04:00') }), // 2h @80 + 4h @90
      rec({ clockIn: mnl('2026-10-09 08:00'), clockOut: mnl('2026-10-09 10:00') }), // 2h @90
    ];
    const r = calculatePayroll(input({ rates, records }));
    const e = r.employees[0];
    expect(e?.rate_lines).toEqual([
      expect.objectContaining({ rate_id: 'old', payable_ms: 6 * H, amount: '480.00' }),
      expect.objectContaining({ rate_id: 'new', payable_ms: 6 * H, amount: '540.00' }),
    ]);
    expect(e?.basic_pay).toBe('1020.00');
    const overnight = e?.shifts[1];
    expect(overnight?.business_date).toBe('2026-10-07');
    expect(overnight?.segments.map((s) => [s.business_date, s.payable_ms, s.hourly_rate])).toEqual([
      ['2026-10-07', 2 * H, '80.00'],
      ['2026-10-08', 4 * H, '90.00'],
    ]);
    // Night hours on the overnight shift are flagged for review, not paid extra.
    expect(r.issues.find((i) => i.code === 'NIGHT_HOURS')?.severity).toBe('special_pay');
    expect(r.canFinalize).toBe(false);
  });

  it('blocks on a missing rate rather than paying zero', () => {
    const r = calculatePayroll(input({ rates: [{ id: 'late', employeeId: 'emp-a', effectiveFrom: '2026-10-10', hourlyRate: '80.00' }], records: [rec({ clockIn: mnl('2026-10-05 08:00'), clockOut: mnl('2026-10-05 12:00') })] }));
    expect(r.issues.find((i) => i.code === 'RATE_MISSING')?.severity).toBe('blocking');
    expect(r.employees[0]?.basic_pay).toBe('0.00');
    expect(r.canFinalize).toBe(false);
  });

  it('flags open attendance, open/overlapping/out-of-shift breaks and overlapping records without inventing times', () => {
    const open = rec({ clockIn: mnl('2026-10-04 08:00'), clockOut: null });
    const openBreak = rec({ clockIn: mnl('2026-10-05 08:00'), clockOut: mnl('2026-10-05 12:00'), breaks: [{ id: 'ob', startedAt: mnl('2026-10-05 10:00'), endedAt: null }] });
    const overlapBreaks = rec({
      clockIn: mnl('2026-10-06 08:00'),
      clockOut: mnl('2026-10-06 12:00'),
      breaks: [
        { id: 'x1', startedAt: mnl('2026-10-06 09:00'), endedAt: mnl('2026-10-06 10:00') },
        { id: 'x2', startedAt: mnl('2026-10-06 09:30'), endedAt: mnl('2026-10-06 10:30') },
      ],
    });
    const outside = rec({ clockIn: mnl('2026-10-07 08:00'), clockOut: mnl('2026-10-07 12:00'), breaks: [{ id: 'o1', startedAt: mnl('2026-10-07 11:30'), endedAt: mnl('2026-10-07 12:30') }] });
    const mine = rec({ id: 'mine', clockIn: mnl('2026-10-08 08:00'), clockOut: mnl('2026-10-08 12:00') });
    const r = calculatePayroll(
      input({
        records: [open, openBreak, overlapBreaks, outside, mine],
        otherRecords: [{ id: 'elsewhere', employeeId: 'emp-a', clockIn: mnl('2026-10-08 11:00'), clockOut: mnl('2026-10-08 15:00') }],
      }),
    );
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['OPEN_ATTENDANCE', 'OPEN_BREAK', 'INVALID_INTERVAL', 'OVERLAPPING_ATTENDANCE']));
    const shifts = r.employees[0]?.shifts ?? [];
    expect(shifts[0]?.clock_out).toBeNull();
    // Only the clean (if overlapping-with-another-branch) shift has payable time; invalid ones pay nothing.
    expect(shifts.slice(0, 4).every((s) => s.payable_ms === 0)).toBe(true);
    expect(r.canFinalize).toBe(false);
  });

  it('flags possible overtime per business date and unblocks once a reviewer records a resolution', () => {
    const records = [rec({ clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 18:00') })];
    const before = calculatePayroll(input({ records }));
    const ot = before.issues.find((i) => i.code === 'POSSIBLE_OVERTIME');
    expect(ot?.key).toBe('overtime:emp-a:2026-10-02');
    expect(before.employees[0]?.basic_pay).toBe('800.00'); // straight time only; no premium invented
    expect(before.canFinalize).toBe(false);
    const after = calculatePayroll(input({ records, resolutions: [{ issueKey: 'overtime:emp-a:2026-10-02', note: 'Approved schedule; premium paid as allowance', byName: 'Sam', at: new Date('2026-10-16T00:00:00Z') }] }));
    expect(after.canFinalize).toBe(true);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('applies labelled adjustments exactly and blocks a negative total', () => {
    const records = [rec({ clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 12:00') })]; // 320.00
    const adj = (id: string, kind: 'earning' | 'deduction', amount: string) => ({
      id,
      employee_id: 'emp-a',
      kind,
      category: kind === 'earning' ? 'allowance' : 'documented_deduction',
      amount,
      reason: 'x',
      documentation_ref: kind === 'deduction' ? 'Signed form 12' : null,
      copied_from_id: null,
      created_by_name: 'Sam',
      created_at: `2026-10-16T00:00:0${id.length}.000Z`,
      voided_at: null,
      void_reason: null,
    });
    const ok = calculatePayroll(input({ records, adjustments: [adj('a', 'earning', '50.10'), adj('bb', 'deduction', '20.05')] }));
    expect(ok.employees[0]).toMatchObject({ basic_pay: '320.00', earnings_adjustments: '50.10', deductions: '20.05', calculated_total: '350.05' });
    const negative = calculatePayroll(input({ records, adjustments: [adj('c', 'deduction', '400.00')] }));
    expect(negative.issues.find((i) => i.code === 'NEGATIVE_TOTAL')?.severity).toBe('blocking');
    const voided = calculatePayroll(input({ records, adjustments: [{ ...adj('d', 'deduction', '400.00'), voided_at: '2026-10-16T01:00:00.000Z', void_reason: 'entered twice' }] }));
    expect(voided.employees[0]?.calculated_total).toBe('320.00');
  });

  it('rounds once per employee and rate, so the breakdown always adds up to basic pay', () => {
    // 7h 59m 31s at 75.55/h across three shifts: exact = 603.6913..., not a sum of per-shift roundings.
    const records = [
      rec({ clockIn: mnl('2026-10-02 08:00:00'.slice(0, 16)), clockOut: new Date(mnl('2026-10-02 10:00').getTime() + 40_333) }),
      rec({ clockIn: mnl('2026-10-03 08:00'), clockOut: new Date(mnl('2026-10-03 10:00').getTime() + 40_333) }),
      rec({ clockIn: mnl('2026-10-04 08:00'), clockOut: new Date(mnl('2026-10-04 11:58').getTime() + 30_334) }),
    ];
    const r = calculatePayroll(input({ rates: [{ id: 'r', employeeId: 'emp-a', effectiveFrom: '2026-01-01', hourlyRate: '75.55' }], records }));
    const e = r.employees[0];
    const totalMs = 2 * (2 * H + 40_333) + (3 * H + 58 * M + 30_334);
    expect(e?.payable_ms).toBe(totalMs);
    const expected = formatCentavos(centavoMsToCentavos(7555n * BigInt(totalMs)));
    expect(e?.basic_pay).toBe(expected);
    expect(e?.rate_lines[0]?.amount).toBe(expected);
  });

  it('excludes non-staff attendance, blocks without a policy or attendance, and on a stale period shape', () => {
    const employees = new Map([['sup', { id: 'sup', name: 'Sup', employeeCode: null, role: 'supervisor', assignments: [] }]]);
    const r = calculatePayroll(input({ employees, records: [rec({ employeeId: 'sup', clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 12:00') })] }));
    expect(r.employees).toHaveLength(0);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['NON_STAFF_EXCLUDED', 'NO_ATTENDANCE']));
    expect(calculatePayroll(input({ policy: null })).issues[0]?.code).toBe('POLICY_MISSING');
    expect(calculatePayroll(input({ periodMatchesPolicy: false })).issues[0]?.code).toBe('PERIOD_POLICY_MISMATCH');
  });

  it('warns when no recorded assignment covers the shift, and marks corrected records', () => {
    const employees = new Map([['emp-a', { id: 'emp-a', name: 'Ana', employeeCode: null, role: 'staff', assignments: [{ assignedAt: new Date('2026-10-10T00:00:00Z'), removedAt: null }] }]]);
    const r = calculatePayroll(
      input({
        employees,
        records: [rec({ clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 12:00'), originalRecordId: 'orig', correctedByName: 'Sam', correctionReason: 'forgot to clock out' })],
      }),
    );
    expect(r.issues.find((i) => i.code === 'ASSIGNMENT_NOT_COVERING')?.severity).toBe('warning');
    expect(r.issues.find((i) => i.code === 'CORRECTED_RECORD')?.severity).toBe('info');
    expect(r.canFinalize).toBe(true);
  });

  it('is deterministic: identical inputs give an identical fingerprint; any input change alters it', () => {
    const records = [rec({ id: 'fixed', clockIn: mnl('2026-10-02 08:00'), clockOut: mnl('2026-10-02 12:00') })];
    const a = calculatePayroll(input({ records }));
    const b = calculatePayroll(input({ records }));
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = calculatePayroll(input({ records, rates: [{ id: 'rate-a1', employeeId: 'emp-a', effectiveFrom: '2026-01-01', hourlyRate: '80.01' }] }));
    expect(c.fingerprint).not.toBe(a.fingerprint);
    const d = calculatePayroll(input({ records: [{ ...records[0], clockOut: mnl('2026-10-02 12:01') } as CalcRecord] }));
    expect(d.fingerprint).not.toBe(a.fingerprint);
  });
});
