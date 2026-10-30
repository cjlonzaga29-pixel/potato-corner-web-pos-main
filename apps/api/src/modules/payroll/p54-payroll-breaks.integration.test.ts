import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P54 — P52 payroll on top of the P53 (P50R + P51) integration.
 * Attendance and breaks are written through the real P51 service (clock-in,
 * Start Break / Resume, clock-out while on break, supervisor correction)
 * under a faked wall clock, then read back by the real payroll service:
 * paid / unpaid / paid-up-to-limit treatment of multiple, overnight and
 * clock-out-closed breaks, open and corrected records, branch scope, and
 * the finalized snapshot surviving later policy changes. Same safety
 * convention as payroll.integration.test.ts — loopback DATABASE_URL only.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));

const { prisma } = await import('../../lib/prisma.js');
const { payrollService } = await import('./payroll.service.js');
const { PayrollError } = await import('./payroll.types.js');
const { buildPayrollCsv } = await import('./payroll-export.js');
const { attendanceService } = await import('../attendance/attendance.service.js');
const { AttendanceError } = await import('../attendance/attendance.types.js');

function mnl(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+08:00`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((e: unknown) => (e instanceof PayrollError || e instanceof AttendanceError) && e.code === code);
}

const HOUR = 3_600_000;

describe.skipIf(!isLocalDatabase)('P54 payroll × P51 breaks integration (real Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  let branchA: string;
  let branchB: string;
  let ana: string;
  let ben: string;
  let supA: JwtPayload;
  let supB: JwtPayload;
  let staffAna: JwtPayload;
  let branchActor: JwtPayload;
  const userIds: string[] = [];

  /** Run one P51 action with the (faked) server clock at a Manila wall time. */
  async function at<T>(local: string, action: () => Promise<T>): Promise<T> {
    vi.setSystemTime(mnl(local));
    return action();
  }

  const anaActor = () => ({ id: ana, role: 'staff' });
  const clockIn = (employeeId: string, local: string) =>
    at(local, () => attendanceService.clockIn({ employeeId, branchId: branchA, gpsLat: 14.6, gpsLng: 121.0 }, { id: employeeId, role: 'staff' }));
  const clockOut = (employeeId: string, local: string) => at(local, () => attendanceService.clockOut(employeeId, {}, { id: employeeId, role: 'staff' }));
  const startBreak = (local: string) => at(local, () => attendanceService.startBreak(ana, branchA, anaActor()));
  const endBreak = (local: string) => at(local, () => attendanceService.endBreak(ana, branchA, anaActor()));

  async function savePolicy(treatment: 'paid' | 'unpaid' | 'paid_up_to_limit', limit: number | null = null) {
    const current = await payrollService.getSettings(supA, branchA);
    return payrollService.savePolicy(supA, branchA, {
      timezone: 'Asia/Manila',
      period_type: 'semi_monthly',
      semi_monthly_first_end_day: 15,
      break_treatment: treatment,
      paid_break_limit_minutes: limit,
      expected_version: current.policy?.version ?? 0,
    });
  }

  async function draft() {
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    return payrollService.getRun(supA, branchA, run.id);
  }

  async function clean() {
    const runs = await prisma.payrollRun.findMany({ where: { branchId: { in: [branchA, branchB] } }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await prisma.payrollAttendanceClaim.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRunLine.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollAdjustment.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollIssueResolution.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds }, revisionOfId: { not: null } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.employeePayRate.deleteMany({ where: { branchId: { in: [branchA, branchB] } } });
    await prisma.payrollPolicy.deleteMany({ where: { branchId: { in: [branchA, branchB] } } });
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [ana, ben] }, originalRecordId: { not: null } } });
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [ana, ben] } } });
    await prisma.shift.deleteMany({ where: { branchId: { in: [branchA, branchB] } } });
  }

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.branch.create({ data: { name: `P54 IT A ${tag}`, code: `P54A${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } }),
      prisma.branch.create({ data: { name: `P54 IT B ${tag}`, code: `P54B${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } }),
    ]);
    branchA = a.id;
    branchB = b.id;
    const mk = (role: 'staff' | 'supervisor' | 'branch', first: string) =>
      prisma.user.create({
        data: { role, firstName: first, lastName: `IT${tag}`, employeeId: `P54-${first}-${tag}`, employmentType: 'regular', email: role === 'staff' ? null : `${first.toLowerCase()}-${tag}@p54.test` },
      });
    const [uAna, uBen, uSupA, uSupB, uBranch] = await Promise.all([mk('staff', 'Ana'), mk('staff', 'Ben'), mk('supervisor', 'SupA'), mk('supervisor', 'SupB'), mk('branch', 'Terminal')]);
    ana = uAna.id;
    ben = uBen.id;
    userIds.push(ana, ben, uSupA.id, uSupB.id, uBranch.id);
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ana, branchId: branchA, assignedAt: longAgo },
        { userId: ben, branchId: branchA, assignedAt: longAgo },
        { userId: uSupA.id, branchId: branchA, assignedAt: longAgo },
        { userId: uSupB.id, branchId: branchB, assignedAt: longAgo },
        { userId: uBranch.id, branchId: branchA, assignedAt: longAgo },
      ],
    });
    const base = { iat: 0, exp: 9_999_999_999 };
    supA = { ...base, user_id: uSupA.id, role: 'supervisor', email: uSupA.email as string, branch_ids: [branchA] } as JwtPayload;
    // A stale JWT claiming branch A must not matter: payroll scope is read from the DB.
    supB = { ...base, user_id: uSupB.id, role: 'supervisor', email: uSupB.email as string, branch_ids: [branchA, branchB] } as JwtPayload;
    staffAna = { ...base, user_id: ana, role: 'staff', email: '', branch_ids: [branchA] } as JwtPayload;
    branchActor = { ...base, user_id: uBranch.id, role: 'branch', email: uBranch.email as string, branch_ids: [branchA] } as JwtPayload;
  });

  beforeEach(async () => {
    await clean();
    const rates = await payrollService.listRates(supA, branchA);
    const latest = (id: string) => rates.employees.find((e) => e.employee_id === id)?.latest_rate_id ?? null;
    await payrollService.createRate(supA, branchA, { employee_id: ana, effective_from: '2026-10-01', hourly_rate: '100', reason: 'p54', expected_latest_rate_id: latest(ana) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await clean();
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchA, branchB] } } });
  });

  it('applies the paid / unpaid / paid-up-to-limit policy to multiple, overnight and clock-out-closed P51 breaks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 16 Oct: two resumed breaks (30 + 15 min) in a 9 h shift.
    await clockIn(ana, '2026-10-16 08:00');
    await startBreak('2026-10-16 12:00');
    await endBreak('2026-10-16 12:30');
    await startBreak('2026-10-16 15:00');
    await endBreak('2026-10-16 15:15');
    await clockOut(ana, '2026-10-16 17:00');
    // 17 → 18 Oct overnight: a 30 min break across midnight in an 8 h shift.
    await clockIn(ana, '2026-10-17 22:00');
    await startBreak('2026-10-17 23:45');
    await endBreak('2026-10-18 00:15');
    await clockOut(ana, '2026-10-18 06:00');
    // 19 Oct: clocks out while still on break — P51 closes the break at clock-out.
    await clockIn(ana, '2026-10-19 08:00');
    await startBreak('2026-10-19 12:00');
    await clockOut(ana, '2026-10-19 13:00');
    vi.useRealTimers();

    const breaks = await prisma.attendanceBreak.findMany({ where: { attendanceRecord: { employeeId: ana } }, orderBy: { startedAt: 'asc' } });
    expect(breaks.map((b) => b.endReason)).toEqual(['resumed', 'resumed', 'resumed', 'clock_out']);
    expect(breaks.every((b) => b.endedAt !== null)).toBe(true);

    await savePolicy('unpaid');
    let detail = await draft();
    const shifts = detail.employees.find((e) => e.employee_id === ana)?.shifts ?? [];
    expect(shifts.map((s) => s.break_source)).toEqual(['intervals', 'intervals', 'intervals']);
    // The overnight shift belongs to its clock-in business date and is never split across days by the break.
    expect(shifts.map((s) => s.business_date)).toEqual(['2026-10-16', '2026-10-17', '2026-10-19']);
    expect(shifts.map((s) => s.payable_ms)).toEqual([8.25 * HOUR, 7.5 * HOUR, 4 * HOUR]);
    expect(detail.totals.basic_pay).toBe('1975.00');
    // Recorded intervals are used once — never added to the stored break_minutes as well.
    expect(detail.issues.some((i) => i.code === 'LEGACY_BREAK_TOTAL')).toBe(false);
    expect(detail.issues.some((i) => i.code === 'NIGHT_HOURS' && i.severity === 'special_pay')).toBe(true);

    // A draft always follows the current policy version.
    await savePolicy('paid');
    detail = await payrollService.getRun(supA, branchA, detail.id);
    expect(detail.totals.basic_pay).toBe('2200.00');

    // First 15 minutes of break per shift paid: 30 + 15 + 45 min unpaid.
    await savePolicy('paid_up_to_limit', 15);
    detail = await payrollService.getRun(supA, branchA, detail.id);
    expect(detail.employees.find((e) => e.employee_id === ana)?.shifts.map((s) => s.payable_ms)).toEqual([8.5 * HOUR, 7.75 * HOUR, 4.25 * HOUR]);
    expect(detail.totals.basic_pay).toBe('2050.00');
  });

  it('turns open, on-break and rate-less attendance into blocking review items and refuses to finalize', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await clockIn(ana, '2026-10-20 08:00');
    await startBreak('2026-10-20 12:00');
    // A correction cannot drop a break that is still open (P51); payroll never sees a half-corrected record.
    const open = await prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: ana, clockOutServerTime: null } });
    await at('2026-10-20 12:10', () => expectCode(attendanceService.manualOverride(open.id, { correctionReason: 'x', clockOutServerTime: mnl('2026-10-20 17:00') }, { id: supA.user_id, role: 'supervisor' }), 'BREAK_IN_PROGRESS'));
    // Ben worked a full shift but has no rate at this branch.
    await clockIn(ben, '2026-10-20 08:00');
    await clockOut(ben, '2026-10-20 16:00');
    vi.useRealTimers();
    // A legacy client's unpositioned break total.
    await prisma.attendanceRecord.create({
      data: { employeeId: ana, branchId: branchA, clockInServerTime: mnl('2026-10-17 08:00'), clockOutServerTime: mnl('2026-10-17 17:00'), clockInGpsStatus: 'within_radius', breakMinutes: 60 },
    });

    await savePolicy('unpaid');
    const detail = await draft();
    const codes = (severity: string) => detail.issues.filter((i) => i.severity === severity).map((i) => i.code).sort();
    expect(codes('blocking')).toEqual(['OPEN_ATTENDANCE', 'RATE_MISSING']);
    expect(codes('warning')).toEqual(['LEGACY_BREAK_TOTAL']);
    expect(detail.can_finalize).toBe(false);
    // The open shift pays nothing until it is closed; the legacy day pays 8 h.
    expect(detail.employees.find((e) => e.employee_id === ana)?.basic_pay).toBe('800.00');
    await expectCode(payrollService.finalize(supA, branchA, detail.id, { expected_fingerprint: detail.fingerprint as string, acknowledge_scope: true }), 'BLOCKING_ISSUES');
  });

  it('keeps recorded break time when a supervisor corrects a forgotten clock-out after a resumed break', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 21 Oct: a 1 h break, resumed, then no clock-out.
    await clockIn(ana, '2026-10-21 08:00');
    await startBreak('2026-10-21 12:00');
    await endBreak('2026-10-21 13:00');
    const forgotten = await prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: ana, clockOutServerTime: null } });
    // 22 Oct: a normal shift with a 30 min break; the supervisor later moves its clock-out.
    const corrector = { id: supA.user_id, role: 'supervisor' };
    await at('2026-10-22 07:00', () => attendanceService.manualOverride(forgotten.id, { correctionReason: 'forgot to clock out', clockOutServerTime: mnl('2026-10-21 17:00') }, corrector));
    await clockIn(ana, '2026-10-22 08:00');
    await startBreak('2026-10-22 12:00');
    await endBreak('2026-10-22 12:30');
    await clockOut(ana, '2026-10-22 17:00');
    const closed = await prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: ana, deletedAt: null, clockInServerTime: mnl('2026-10-22 08:00') } });
    await at('2026-10-23 07:00', () => attendanceService.manualOverride(closed.id, { correctionReason: 'left at 16:00', clockOutServerTime: mnl('2026-10-22 16:00') }, corrector));
    vi.useRealTimers();

    const corrections = await prisma.attendanceRecord.findMany({ where: { employeeId: ana, deletedAt: null }, orderBy: { clockInServerTime: 'asc' } });
    expect(corrections.map((r) => [r.originalRecordId !== null, r.breakMinutes])).toEqual([
      [true, 60],
      [true, 30],
    ]);

    await savePolicy('unpaid');
    const detail = await draft();
    const shifts = detail.employees.find((e) => e.employee_id === ana)?.shifts ?? [];
    expect(shifts.map((s) => [s.business_date, s.break_source, s.payable_ms])).toEqual([
      ['2026-10-21', 'legacy_total', 8 * HOUR],
      ['2026-10-22', 'legacy_total', 7.5 * HOUR],
    ]);
    // The reviewer sees both that the record was corrected and that only a break total survived.
    expect(detail.issues.filter((i) => i.code === 'CORRECTED_RECORD')).toHaveLength(2);
    expect(detail.issues.filter((i) => i.code === 'LEGACY_BREAK_TOTAL')).toHaveLength(2);
    expect(detail.totals.basic_pay).toBe('1550.00');
  });

  it('confines payroll to the current branch assignment and lets only supervisors/admins change settings', async () => {
    await savePolicy('unpaid');
    const detail = await draft();
    // Stale JWT branch_ids do not grant access; branch accounts and staff have none.
    await expectCode(payrollService.getSettings(supB, branchA), 'BRANCH_ACCESS_DENIED');
    await expectCode(payrollService.getRun(supB, branchA, detail.id), 'BRANCH_ACCESS_DENIED');
    await expectCode(payrollService.getRun(supB, branchB, detail.id), 'RUN_NOT_FOUND');
    await expectCode(payrollService.savePolicy(supB, branchA, { timezone: 'Asia/Manila', period_type: 'monthly', semi_monthly_first_end_day: null, break_treatment: 'paid', paid_break_limit_minutes: null, expected_version: 1 }), 'BRANCH_ACCESS_DENIED');
    await expectCode(payrollService.createRate(supB, branchA, { employee_id: ana, effective_from: '2026-10-20', hourly_rate: '500', reason: 'x', expected_latest_rate_id: null }), 'BRANCH_ACCESS_DENIED');
    for (const actor of [branchActor, staffAna]) {
      await expectCode(payrollService.getSettings(actor, branchA), 'INSUFFICIENT_PERMISSIONS');
      await expectCode(payrollService.savePolicy(actor, branchA, { timezone: 'Asia/Manila', period_type: 'monthly', semi_monthly_first_end_day: null, break_treatment: 'paid', paid_break_limit_minutes: null, expected_version: 1 }), 'INSUFFICIENT_PERMISSIONS');
    }
    expect((await payrollService.getSettings(supA, branchA)).policy?.break_treatment).toBe('unpaid');
  });

  it('keeps a finalized run on its snapshot after policy and rate changes, and its CSV matches and discloses exclusions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await clockIn(ana, '2026-10-16 08:00');
    await startBreak('2026-10-16 12:00');
    await endBreak('2026-10-16 13:00');
    await clockOut(ana, '2026-10-16 17:00');
    vi.useRealTimers();

    await savePolicy('unpaid');
    const preview = await draft();
    expect(preview.totals.calculated_total).toBe('800.00');
    await payrollService.finalize(supA, branchA, preview.id, { expected_fingerprint: preview.fingerprint as string, acknowledge_scope: true });

    await savePolicy('paid');
    const rates = await payrollService.listRates(supA, branchA);
    await payrollService.createRate(supA, branchA, {
      employee_id: ana,
      effective_from: '2026-10-16',
      hourly_rate: '120',
      reason: 'later raise',
      expected_latest_rate_id: rates.employees.find((e) => e.employee_id === ana)?.latest_rate_id ?? null,
    });

    const finalized = await payrollService.getRun(supA, branchA, preview.id);
    expect(finalized.basis).toBe('finalized_snapshot');
    expect(finalized.status).toBe('finalized');
    expect(finalized.policy?.break_treatment).toBe('unpaid');
    expect(finalized.totals.calculated_total).toBe('800.00');
    expect(finalized.source_changes).toEqual([]);

    const csv = buildPayrollCsv(finalized).toString('utf8');
    const totalRow = csv.split('\r\n').find((l) => l.startsWith('TOTAL,'));
    expect(totalRow).toContain('800.00');
    expect(csv).toContain('Not included');
    for (const excluded of finalized.exclusions) expect(csv).toContain(excluded);
    expect(finalized.exclusions.join(' ')).toMatch(/Withholding tax/);
    expect(finalized.exclusions.join(' ')).toMatch(/Overtime premium/);
  });
});
