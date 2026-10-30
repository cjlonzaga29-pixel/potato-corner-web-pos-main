import { createHash } from 'node:crypto';
import type {
  PayrollAdjustmentView,
  PayrollBreakDetail,
  PayrollBreakTreatment,
  PayrollEmployeeResult,
  PayrollIssue,
  PayrollRateLine,
  PayrollSegmentDetail,
  PayrollShiftDetail,
  PayrollTotals,
} from '@potato-corner/shared';
import { centavoMs, centavoMsToCentavos, decimalToCentavos, formatCentavos, msToMinutesText } from './payroll-money.js';
import { addDays, businessDateKey, businessTime, startOfBusinessDate } from './payroll-time.js';

/**
 * POS-PERF-P52 — pure payroll calculation. No database, no clock: every
 * input is passed in, so a draft preview and the finalize-time recalculation
 * produce byte-identical output (and fingerprint) for identical inputs.
 * Rules: docs/runbooks/pos-perf-p52-payroll-settings-and-reports.md §3.
 */

export interface CalcPolicy {
  version: number;
  timezone: string;
  breakTreatment: PayrollBreakTreatment;
  paidBreakLimitMinutes: number | null;
}

export interface CalcBreak {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface CalcRecord {
  id: string;
  employeeId: string;
  branchId: string;
  clockIn: Date;
  clockOut: Date | null;
  breakMinutes: number;
  breaks: CalcBreak[];
  originalRecordId: string | null;
  correctedByName: string | null;
  correctionReason: string | null;
}

/** Another attendance record of the same employee (any branch) — used only to detect overlaps. */
export interface CalcOtherRecord {
  id: string;
  employeeId: string;
  clockIn: Date;
  clockOut: Date | null;
}

export interface CalcEmployee {
  id: string;
  name: string;
  employeeCode: string | null;
  role: string;
  /** Assignment history at THIS branch. */
  assignments: Array<{ assignedAt: Date; removedAt: Date | null }>;
}

export interface CalcRate {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  hourlyRate: string;
}

export interface CalcAdjustment extends PayrollAdjustmentView {
  employee_id: string;
}

export interface CalcResolution {
  issueKey: string;
  note: string;
  byName: string;
  at: Date;
}

export interface CalcInput {
  policy: CalcPolicy | null;
  periodStart: string;
  periodEnd: string;
  regularShiftMinutes: number;
  records: CalcRecord[];
  otherRecords: CalcOtherRecord[];
  employees: Map<string, CalcEmployee>;
  rates: CalcRate[];
  adjustments: CalcAdjustment[];
  resolutions: CalcResolution[];
  previousTotals: Map<string, string> | null;
  /** False when the branch policy changed after this run was created and the period no longer matches its cutoffs. */
  periodMatchesPolicy: boolean;
}

export interface CalcResult {
  employees: PayrollEmployeeResult[];
  issues: PayrollIssue[];
  totals: PayrollTotals;
  blockingCount: number;
  canFinalize: boolean;
  usedRateIds: string[];
  attendanceRecordIds: Array<{ id: string; employeeId: string }>;
  fingerprint: string;
}

const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;

interface Interval {
  start: number;
  end: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** [a] minus every interval in `cut` (sorted, non-overlapping, inside a). */
function subtractIntervals(whole: Interval, cut: Interval[]): Interval[] {
  const pieces: Interval[] = [];
  let cursor = whole.start;
  for (const c of cut) {
    if (c.end <= cursor || c.start >= whole.end) continue;
    if (c.start > cursor) pieces.push({ start: cursor, end: Math.min(c.start, whole.end) });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < whole.end) pieces.push({ start: cursor, end: whole.end });
  return pieces.filter((p) => p.end > p.start);
}

/** Split intervals at business-date (local midnight) boundaries; each piece carries its business date. */
function splitByBusinessDate(pieces: Interval[], timeZone: string): Array<Interval & { date: string }> {
  const out: Array<Interval & { date: string }> = [];
  for (const piece of pieces) {
    let cursor = piece.start;
    while (cursor < piece.end) {
      const date = businessDateKey(new Date(cursor), timeZone);
      const nextMidnight = startOfBusinessDate(addDays(date, 1), timeZone).getTime();
      const end = Math.min(piece.end, nextMidnight);
      out.push({ start: cursor, end, date });
      cursor = end;
    }
  }
  return out;
}

function nightOverlapMs(pieces: Interval[], timeZone: string): number {
  let total = 0;
  for (const piece of pieces) {
    const firstDate = addDays(businessDateKey(new Date(piece.start), timeZone), -1);
    const lastDate = businessDateKey(new Date(piece.end), timeZone);
    for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
      const nightStart = businessTime(date, NIGHT_START_HOUR, timeZone).getTime();
      const nightEnd = businessTime(addDays(date, 1), NIGHT_END_HOUR, timeZone).getTime();
      total += Math.max(0, Math.min(piece.end, nightEnd) - Math.max(piece.start, nightStart));
    }
  }
  return total;
}

function rateFor(rates: CalcRate[], employeeId: string, date: string): CalcRate | null {
  let best: CalcRate | null = null;
  for (const rate of rates) {
    if (rate.employeeId !== employeeId || rate.effectiveFrom > date) continue;
    if (!best || rate.effectiveFrom > best.effectiveFrom) best = rate;
  }
  return best;
}

function allowanceMs(treatment: PayrollBreakTreatment, limitMinutes: number | null): number {
  if (treatment === 'paid') return Number.POSITIVE_INFINITY;
  if (treatment === 'unpaid') return 0;
  return (limitMinutes ?? 0) * 60_000;
}

function sortKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKey);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKey((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function fingerprintOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKey(payload))).digest('hex');
}

interface ShiftOutcome {
  detail: PayrollShiftDetail;
  segments: Array<{ date: string; ms: number; rate: CalcRate | null }>;
  payablePieces: Interval[];
}

export function calculatePayroll(input: CalcInput): CalcResult {
  const issues: PayrollIssue[] = [];
  const resolutionByKey = new Map(input.resolutions.map((r) => [r.issueKey, r]));
  const addIssue = (issue: Omit<PayrollIssue, 'resolution'>): void => {
    if (issues.some((existing) => existing.key === issue.key)) return;
    const resolution = issue.severity === 'special_pay' ? resolutionByKey.get(issue.key) : undefined;
    issues.push({
      ...issue,
      resolution: resolution ? { note: resolution.note, by: resolution.byName, at: resolution.at.toISOString() } : null,
    });
  };

  const policy = input.policy;
  if (!policy) {
    addIssue({
      key: 'policy_missing',
      code: 'POLICY_MISSING',
      severity: 'blocking',
      message: 'This branch has no payroll policy yet. Set the timezone, pay period and break treatment in Pay settings.',
      employee_id: null,
      attendance_record_id: null,
      business_date: null,
    });
  }

  if (policy && !input.periodMatchesPolicy) {
    addIssue({
      key: 'period_policy_mismatch',
      code: 'PERIOD_POLICY_MISMATCH',
      severity: 'blocking',
      message: 'The pay-period settings changed after this draft was created; this period no longer matches them. Discard this draft and generate one for a current period.',
      employee_id: null,
      attendance_record_id: null,
      business_date: null,
    });
  }

  const timeZone = policy?.timezone ?? 'UTC';
  const staffRecords: CalcRecord[] = [];
  let nonStaff = 0;
  for (const record of input.records) {
    const employee = input.employees.get(record.employeeId);
    if (employee && employee.role === 'staff') staffRecords.push(record);
    else nonStaff += 1;
  }
  if (nonStaff > 0) {
    addIssue({
      key: 'non_staff_excluded',
      code: 'NON_STAFF_EXCLUDED',
      severity: 'info',
      message: `${nonStaff} attendance record(s) of non-staff accounts (e.g. supervisors) at this branch are not part of staff payroll.`,
      employee_id: null,
      attendance_record_id: null,
      business_date: null,
    });
  }

  const byEmployee = new Map<string, CalcRecord[]>();
  for (const record of staffRecords) {
    const list = byEmployee.get(record.employeeId) ?? [];
    list.push(record);
    byEmployee.set(record.employeeId, list);
  }
  // Adjustments can only exist for employees in the run; keep them visible even if attendance later vanished.
  for (const adjustment of input.adjustments) {
    if (!byEmployee.has(adjustment.employee_id) && input.employees.get(adjustment.employee_id)?.role === 'staff') {
      byEmployee.set(adjustment.employee_id, []);
    }
  }

  const usedRateIds = new Set<string>();
  const employeeResults: PayrollEmployeeResult[] = [];
  let totalBasic = 0n;
  let totalEarn = 0n;
  let totalDed = 0n;
  let totalMs = 0;

  const employeeIds = [...byEmployee.keys()].sort((a, b) => {
    const na = input.employees.get(a)?.name ?? a;
    const nb = input.employees.get(b)?.name ?? b;
    return na.localeCompare(nb) || a.localeCompare(b);
  });

  for (const employeeId of employeeIds) {
    const employee = input.employees.get(employeeId);
    const records = (byEmployee.get(employeeId) ?? []).slice().sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
    const shifts: ShiftOutcome[] = [];
    const employeeIssueKeys: string[] = [];
    const pushIssue = (issue: Omit<PayrollIssue, 'resolution'>, shift?: PayrollShiftDetail): void => {
      addIssue(issue);
      if (!employeeIssueKeys.includes(issue.key)) employeeIssueKeys.push(issue.key);
      if (shift && !shift.issue_codes.includes(issue.code)) shift.issue_codes.push(issue.code);
    };

    for (const record of records) {
      const clockIn = record.clockIn.getTime();
      const clockOut = record.clockOut?.getTime() ?? null;
      const businessDate = businessDateKey(record.clockIn, timeZone);
      const base = { employee_id: employeeId, attendance_record_id: record.id, business_date: businessDate };
      const detail: PayrollShiftDetail = {
        attendance_record_id: record.id,
        business_date: businessDate,
        clock_in: record.clockIn.toISOString(),
        clock_out: record.clockOut?.toISOString() ?? null,
        span_ms: clockOut !== null ? Math.max(0, clockOut - clockIn) : 0,
        break_source: record.breaks.length > 0 ? 'intervals' : record.breakMinutes > 0 ? 'legacy_total' : 'none',
        breaks: [],
        break_ms: 0,
        unpaid_break_ms: 0,
        payable_ms: 0,
        segments: [],
        corrected: record.originalRecordId ? { by: record.correctedByName, reason: record.correctionReason } : null,
        note: null,
        issue_codes: [],
      };
      const outcome: ShiftOutcome = { detail, segments: [], payablePieces: [] };
      shifts.push(outcome);

      if (record.originalRecordId) {
        pushIssue(
          {
            ...base,
            key: `corrected:${record.id}`,
            code: 'CORRECTED_RECORD',
            severity: 'info',
            message: `Attendance corrected by ${record.correctedByName ?? 'a supervisor'}${record.correctionReason ? ` — "${record.correctionReason}"` : ''}.`,
          },
          detail,
        );
      }

      if (employee && !employee.assignments.some((a) => a.assignedAt.getTime() <= clockIn && (a.removedAt === null || a.removedAt.getTime() > clockIn))) {
        pushIssue(
          {
            ...base,
            key: `assignment:${record.id}`,
            code: 'ASSIGNMENT_NOT_COVERING',
            severity: 'warning',
            message: 'No recorded branch assignment covers this shift. The shift was recorded at this branch, so it is included; confirm it belongs here.',
          },
          detail,
        );
      }

      const overlapping = input.otherRecords.some(
        (other) =>
          other.id !== record.id &&
          other.employeeId === employeeId &&
          other.clockIn.getTime() < (clockOut ?? Number.POSITIVE_INFINITY) &&
          clockIn < (other.clockOut?.getTime() ?? Number.POSITIVE_INFINITY),
      );
      if (overlapping) {
        pushIssue(
          {
            ...base,
            key: `overlap:${record.id}`,
            code: 'OVERLAPPING_ATTENDANCE',
            severity: 'blocking',
            message: 'This shift overlaps another attendance record of the same employee. Correct the attendance before finalizing.',
          },
          detail,
        );
      }

      if (clockOut === null) {
        pushIssue(
          { ...base, key: `open:${record.id}`, code: 'OPEN_ATTENDANCE', severity: 'blocking', message: 'Still clocked in — no clock-out recorded. Nothing is paid for this shift until it is closed.' },
          detail,
        );
        continue;
      }
      if (clockOut < clockIn) {
        pushIssue(
          { ...base, key: `invalid:${record.id}`, code: 'INVALID_INTERVAL', severity: 'blocking', message: 'Clock-out is before clock-in.' },
          detail,
        );
        continue;
      }
      if (!policy) continue;

      const allowance = allowanceMs(policy.breakTreatment, policy.paidBreakLimitMinutes);
      let remainingAllowance = allowance;
      let payable: Interval[];
      let legacyUnpaidMs = 0;

      if (record.breaks.length > 0) {
        // P51 intervals are authoritative; break_minutes is ignored for this record.
        const sorted = record.breaks.slice().sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
        let invalid = false;
        let previousEnd = Number.NEGATIVE_INFINITY;
        const unpaid: Interval[] = [];
        for (const b of sorted) {
          const start = b.startedAt.getTime();
          const end = b.endedAt?.getTime() ?? null;
          if (end === null) {
            pushIssue({ ...base, key: `open_break:${b.id}`, code: 'OPEN_BREAK', severity: 'blocking', message: 'A break on this shift was never ended.' }, detail);
            invalid = true;
            detail.breaks.push({ started_at: iso(start), ended_at: null, minutes: '0.00', paid_minutes: '0.00', unpaid_minutes: '0.00', source: 'interval' });
            continue;
          }
          if (start < clockIn || end > clockOut) {
            pushIssue({ ...base, key: `break_outside:${b.id}`, code: 'INVALID_INTERVAL', severity: 'blocking', message: 'A recorded break lies outside the shift.' }, detail);
            invalid = true;
          }
          if (start < previousEnd) {
            pushIssue({ ...base, key: `break_overlap:${b.id}`, code: 'INVALID_INTERVAL', severity: 'blocking', message: 'Two recorded breaks overlap.' }, detail);
            invalid = true;
          }
          previousEnd = Math.max(previousEnd, end);
          const length = end - start;
          const paidPart = Math.min(length, remainingAllowance);
          remainingAllowance -= paidPart;
          if (length - paidPart > 0) unpaid.push({ start: start + paidPart, end });
          detail.break_ms += length;
          detail.unpaid_break_ms += length - paidPart;
          detail.breaks.push({
            started_at: iso(start),
            ended_at: iso(end),
            minutes: msToMinutesText(length),
            paid_minutes: msToMinutesText(paidPart),
            unpaid_minutes: msToMinutesText(length - paidPart),
            source: 'interval',
          } satisfies PayrollBreakDetail);
        }
        if (invalid) {
          detail.break_ms = 0;
          detail.unpaid_break_ms = 0;
          continue;
        }
        payable = subtractIntervals({ start: clockIn, end: clockOut }, unpaid);
      } else if (record.breakMinutes > 0) {
        // Legacy fallback: an unpositioned total (pre-P51 records, corrections).
        const breakMs = record.breakMinutes * 60_000;
        if (breakMs > clockOut - clockIn) {
          pushIssue({ ...base, key: `legacy_break_exceeds:${record.id}`, code: 'INVALID_INTERVAL', severity: 'blocking', message: 'Recorded break minutes are longer than the shift.' }, detail);
          continue;
        }
        const paidPart = Math.min(breakMs, allowance);
        legacyUnpaidMs = breakMs - paidPart;
        detail.break_ms = breakMs;
        detail.unpaid_break_ms = legacyUnpaidMs;
        detail.breaks.push({
          started_at: null,
          ended_at: null,
          minutes: msToMinutesText(breakMs),
          paid_minutes: msToMinutesText(paidPart),
          unpaid_minutes: msToMinutesText(legacyUnpaidMs),
          source: 'legacy_total',
        });
        pushIssue(
          {
            ...base,
            key: `legacy_break:${record.id}`,
            code: 'LEGACY_BREAK_TOTAL',
            severity: 'warning',
            message: `Break recorded only as a total (${record.breakMinutes} min, no start/end times). Treated per the break policy.`,
          },
          detail,
        );
        payable = [{ start: clockIn, end: clockOut }];
      } else {
        payable = [{ start: clockIn, end: clockOut }];
      }

      const pieces = splitByBusinessDate(payable, timeZone);
      const segments: PayrollSegmentDetail[] = pieces.map((piece) => ({
        start: iso(piece.start),
        end: iso(piece.end),
        business_date: piece.date,
        payable_ms: piece.end - piece.start,
        hourly_rate: null,
        rate_id: null,
      }));
      // An unpositioned legacy unpaid total comes off the earliest segment(s) first (runbook §3.3).
      let toDeduct = legacyUnpaidMs;
      for (const segment of segments) {
        if (toDeduct <= 0) break;
        const take = Math.min(segment.payable_ms, toDeduct);
        segment.payable_ms -= take;
        toDeduct -= take;
      }
      if (legacyUnpaidMs > 0 && segments.length > 1) {
        detail.note = 'Legacy unpaid break taken from the earliest part of the shift.';
      }

      for (const segment of segments) {
        const rate = rateFor(input.rates, employeeId, segment.business_date);
        if (rate) {
          segment.hourly_rate = rate.hourlyRate;
          segment.rate_id = rate.id;
          usedRateIds.add(rate.id);
        } else if (segment.payable_ms > 0) {
          pushIssue(
            {
              ...base,
              business_date: segment.business_date,
              key: `rate_missing:${employeeId}:${segment.business_date}`,
              code: 'RATE_MISSING',
              severity: 'blocking',
              message: `No hourly rate in effect on ${segment.business_date}. Add one in Pay settings.`,
            },
            detail,
          );
        }
        outcome.segments.push({ date: segment.business_date, ms: segment.payable_ms, rate });
      }
      detail.segments = segments;
      detail.payable_ms = segments.reduce((sum, s) => sum + s.payable_ms, 0);
      outcome.payablePieces = payable;

      if (nightOverlapMs(payable, timeZone) > 0) {
        pushIssue(
          {
            ...base,
            key: `night:${record.id}`,
            code: 'NIGHT_HOURS',
            severity: 'special_pay',
            message: 'Payable time between 22:00 and 06:00. Night-shift differential is not calculated — record how it is handled.',
          },
          detail,
        );
      }
    }

    // Possible overtime: payable time per business date (of clock-in) above the branch's regular hours.
    const perDate = new Map<string, number>();
    for (const shift of shifts) perDate.set(shift.detail.business_date, (perDate.get(shift.detail.business_date) ?? 0) + shift.detail.payable_ms);
    for (const [date, ms] of perDate) {
      if (ms > input.regularShiftMinutes * 60_000) {
        const key = `overtime:${employeeId}:${date}`;
        addIssue({
          key,
          code: 'POSSIBLE_OVERTIME',
          severity: 'special_pay',
          message: `${msToMinutesText(ms)} payable minutes on ${date}, above the branch's regular ${input.regularShiftMinutes} minutes. Overtime premium is not calculated — record how it is handled.`,
          employee_id: employeeId,
          attendance_record_id: null,
          business_date: date,
        });
        if (!employeeIssueKeys.includes(key)) employeeIssueKeys.push(key);
      }
    }

    // Exact pay per rate, rounded once per (employee, rate).
    const byRate = new Map<string, { rate: CalcRate; ms: number; exact: bigint }>();
    for (const shift of shifts) {
      for (const segment of shift.segments) {
        if (!segment.rate || segment.ms <= 0) continue;
        const entry = byRate.get(segment.rate.id) ?? { rate: segment.rate, ms: 0, exact: 0n };
        entry.ms += segment.ms;
        entry.exact += centavoMs(decimalToCentavos(segment.rate.hourlyRate), segment.ms);
        byRate.set(segment.rate.id, entry);
      }
    }
    const rateLines: PayrollRateLine[] = [...byRate.values()]
      .sort((a, b) => a.rate.effectiveFrom.localeCompare(b.rate.effectiveFrom) || a.rate.id.localeCompare(b.rate.id))
      .map((entry) => ({
        hourly_rate: entry.rate.hourlyRate,
        rate_id: entry.rate.id,
        effective_from: entry.rate.effectiveFrom,
        payable_ms: entry.ms,
        amount: formatCentavos(centavoMsToCentavos(entry.exact)),
      }));
    const basic = rateLines.reduce((sum, line) => sum + decimalToCentavos(line.amount), 0n);

    const adjustments = input.adjustments
      .filter((a) => a.employee_id === employeeId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const live = adjustments.filter((a) => a.voided_at === null);
    const earn = live.filter((a) => a.kind === 'earning').reduce((sum, a) => sum + decimalToCentavos(a.amount), 0n);
    const ded = live.filter((a) => a.kind === 'deduction').reduce((sum, a) => sum + decimalToCentavos(a.amount), 0n);
    const total = basic + earn - ded;
    if (total < 0n) {
      const key = `negative_total:${employeeId}`;
      addIssue({
        key,
        code: 'NEGATIVE_TOTAL',
        severity: 'blocking',
        message: 'Deductions exceed this employee\'s pay for the period. Review the deductions.',
        employee_id: employeeId,
        attendance_record_id: null,
        business_date: null,
      });
      employeeIssueKeys.push(key);
    }

    const payableMs = shifts.reduce((sum, s) => sum + s.detail.payable_ms, 0);
    totalBasic += basic;
    totalEarn += earn;
    totalDed += ded;
    totalMs += payableMs;
    employeeResults.push({
      employee_id: employeeId,
      name: employee?.name ?? 'Unknown employee',
      employee_code: employee?.employeeCode ?? null,
      payable_ms: payableMs,
      rate_lines: rateLines,
      basic_pay: formatCentavos(basic),
      earnings_adjustments: formatCentavos(earn),
      deductions: formatCentavos(ded),
      calculated_total: formatCentavos(total),
      shifts: shifts.map((s) => s.detail),
      adjustments: adjustments.map(({ employee_id: _employeeId, ...view }) => view),
      issue_keys: employeeIssueKeys,
      previous_total: input.previousTotals ? (input.previousTotals.get(employeeId) ?? null) : null,
    });
  }

  if (policy && employeeResults.length === 0) {
    addIssue({
      key: 'no_attendance',
      code: 'NO_ATTENDANCE',
      severity: 'blocking',
      message: 'No staff attendance at this branch in this period — there is nothing to finalize.',
      employee_id: null,
      attendance_record_id: null,
      business_date: null,
    });
  }

  const blockingCount = issues.filter((i) => i.severity === 'blocking' || (i.severity === 'special_pay' && i.resolution === null)).length;
  const totals: PayrollTotals = {
    basic_pay: formatCentavos(totalBasic),
    earnings_adjustments: formatCentavos(totalEarn),
    deductions: formatCentavos(totalDed),
    calculated_total: formatCentavos(totalBasic + totalEarn - totalDed),
    payable_ms: totalMs,
  };

  const fingerprint = fingerprintOf({
    policy,
    period: [input.periodStart, input.periodEnd],
    regularShiftMinutes: input.regularShiftMinutes,
    employees: employeeResults,
    issues,
    totals,
  });

  return {
    employees: employeeResults,
    issues,
    totals,
    blockingCount,
    canFinalize: policy !== null && blockingCount === 0,
    usedRateIds: [...usedRateIds].sort(),
    attendanceRecordIds: staffRecords.map((r) => ({ id: r.id, employeeId: r.employeeId })),
    fingerprint,
  };
}

/** Business-date window [start, end) of a period as UTC instants (records are selected by clock-in). */
export function periodWindow(periodStart: string, periodEnd: string, timeZone: string): { from: Date; to: Date } {
  return { from: startOfBusinessDate(periodStart, timeZone), to: startOfBusinessDate(addDays(periodEnd, 1), timeZone) };
}
