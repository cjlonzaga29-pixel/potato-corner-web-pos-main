import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P52 — real-Postgres coverage for payroll: effective-dated rates
 * and stale writes, branch scope (incl. an employee transfer), draft →
 * finalize with snapshot/claims, stale preview, concurrent finalization,
 * duplicate/overlapping coverage, immutability after source edits,
 * revisions, paid marking, and CSV/PDF totals equal to the stored record.
 * Same safety convention as attendance-breaks.integration.test.ts — only
 * runs against a loopback DATABASE_URL, never Supabase/production.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));

const { prisma } = await import('../../lib/prisma.js');
const { payrollService } = await import('./payroll.service.js');
const { PayrollError } = await import('./payroll.types.js');
const { buildPayrollCsv, buildPayrollPdf } = await import('./payroll-export.js');
const { attendanceService } = await import('../attendance/attendance.service.js');

function mnl(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+08:00`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof PayrollError && e.code === code);
}

describe.skipIf(!isLocalDatabase)('payroll integration (real Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  let branchA: string;
  let branchB: string;
  let ana: string;
  let ben: string;
  let dana: string;
  let admin: JwtPayload;
  let supA: JwtPayload;
  let supB: JwtPayload;
  let branchActor: JwtPayload;
  const userIds: string[] = [];

  const policyInput = (expected: number, overrides: Record<string, unknown> = {}) => ({
    timezone: 'Asia/Manila',
    period_type: 'semi_monthly' as const,
    semi_monthly_first_end_day: 15,
    break_treatment: 'unpaid' as const,
    paid_break_limit_minutes: null,
    expected_version: expected,
    ...overrides,
  });

  async function shift(employeeId: string, branchId: string, from: string, to: string | null, breakMinutes = 0) {
    return prisma.attendanceRecord.create({
      data: {
        employeeId,
        branchId,
        clockInServerTime: mnl(from),
        clockOutServerTime: to ? mnl(to) : null,
        clockInGpsLat: 14.6,
        clockInGpsLng: 121.0,
        clockInGpsStatus: 'within_radius',
        breakMinutes,
      },
    });
  }

  async function addRate(actor: JwtPayload, branchId: string, employeeId: string, from: string, rate: string) {
    const list = await payrollService.listRates(actor, branchId);
    const latest = list.employees.find((e) => e.employee_id === employeeId)?.latest_rate_id ?? null;
    return payrollService.createRate(actor, branchId, { employee_id: employeeId, effective_from: from, hourly_rate: rate, reason: 'integration test', expected_latest_rate_id: latest });
  }

  async function cleanPayroll() {
    const branchIds = [branchA, branchB];
    const runs = await prisma.payrollRun.findMany({ where: { branchId: { in: branchIds } }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await prisma.payrollAttendanceClaim.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRunLine.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollAdjustment.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollIssueResolution.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds }, revisionOfId: { not: null } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.employeePayRate.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.payrollPolicy.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [ana, ben, dana] }, originalRecordId: { not: null } } });
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [ana, ben, dana] } } });
  }

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.branch.create({ data: { name: `P52 IT A ${tag}`, code: `P52A${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } }),
      prisma.branch.create({ data: { name: `P52 IT B ${tag}`, code: `P52B${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } }),
    ]);
    branchA = a.id;
    branchB = b.id;
    const mk = (role: 'staff' | 'supervisor' | 'super_admin' | 'branch', first: string) =>
      prisma.user.create({
        data: { role, firstName: first, lastName: `IT${tag}`, employeeId: `P52-${first}-${tag}`, employmentType: 'regular', email: role === 'staff' ? null : `${first.toLowerCase()}-${tag}@p52.test` },
      });
    const [uAna, uBen, uDana, uAdmin, uSupA, uSupB, uBranch] = await Promise.all([
      mk('staff', 'Ana'),
      mk('staff', 'Ben'),
      mk('staff', 'Dana'),
      mk('super_admin', 'Admin'),
      mk('supervisor', 'SupA'),
      mk('supervisor', 'SupB'),
      mk('branch', 'Terminal'),
    ]);
    ana = uAna.id;
    ben = uBen.id;
    dana = uDana.id;
    userIds.push(ana, ben, dana, uAdmin.id, uSupA.id, uSupB.id, uBranch.id);
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ana, branchId: branchA, assignedAt: longAgo },
        { userId: ben, branchId: branchA, assignedAt: longAgo },
        // Dana transferred A → B on 2026-10-20.
        { userId: dana, branchId: branchA, assignedAt: longAgo, removedAt: mnl('2026-10-20 00:00') },
        { userId: dana, branchId: branchB, assignedAt: mnl('2026-10-20 00:00') },
        { userId: uSupA.id, branchId: branchA, assignedAt: longAgo },
        { userId: uSupB.id, branchId: branchB, assignedAt: longAgo },
        { userId: uBranch.id, branchId: branchA, assignedAt: longAgo },
      ],
    });
    const base = { iat: 0, exp: 9_999_999_999 };
    admin = { ...base, user_id: uAdmin.id, role: 'super_admin', email: uAdmin.email as string } as JwtPayload;
    supA = { ...base, user_id: uSupA.id, role: 'supervisor', email: uSupA.email as string, branch_ids: [branchA] } as JwtPayload;
    // A stale JWT claiming branch A must not matter: scope is read from the DB.
    supB = { ...base, user_id: uSupB.id, role: 'supervisor', email: uSupB.email as string, branch_ids: [branchA, branchB] } as JwtPayload;
    branchActor = { ...base, user_id: uBranch.id, role: 'branch', email: uBranch.email as string, branch_ids: [branchA] } as JwtPayload;
  });

  beforeEach(async () => {
    await cleanPayroll();
  });

  afterAll(async () => {
    await cleanPayroll();
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchA, branchB] } } });
  });

  it('versions the policy and refuses a stale overwrite or an unknown timezone', async () => {
    const v1 = await payrollService.savePolicy(supA, branchA, policyInput(0));
    expect(v1.version).toBe(1);
    await expectCode(payrollService.savePolicy(supA, branchA, policyInput(0, { break_treatment: 'paid' })), 'STALE_POLICY');
    await expectCode(payrollService.savePolicy(supA, branchA, policyInput(1, { timezone: 'Mars/Olympus' })), 'INVALID_TIMEZONE');
    const v2 = await payrollService.savePolicy(supA, branchA, policyInput(1, { break_treatment: 'paid_up_to_limit', paid_break_limit_minutes: 15 }));
    expect(v2.version).toBe(2);
    const settings = await payrollService.getSettings(supA, branchA);
    expect(settings.history.map((h) => h.version)).toEqual([2, 1]);
  });

  it('keeps rates effective-dated, refuses stale or duplicate writes, and voids instead of deleting', async () => {
    const r1 = await addRate(supA, branchA, ana, '2026-01-01', '80');
    await expectCode(
      payrollService.createRate(supA, branchA, { employee_id: ana, effective_from: '2026-10-20', hourly_rate: '90', reason: 'raise', expected_latest_rate_id: null }),
      'STALE_RATES',
    );
    await expectCode(
      payrollService.createRate(supA, branchA, { employee_id: ana, effective_from: '2026-01-01', hourly_rate: '85', reason: 'dup', expected_latest_rate_id: r1.id }),
      'RATE_DATE_TAKEN',
    );
    const r2 = await addRate(supA, branchA, ana, '2026-10-20', '90');
    const voided = await payrollService.voidRate(supA, branchA, r2.id, { reason: 'typo', expected_latest_rate_id: r2.id });
    expect(voided.voided_at).not.toBeNull();
    expect(await prisma.employeePayRate.count({ where: { employeeId: ana, branchId: branchA } })).toBe(2);
    // The same date can be used again once the old row is voided.
    const r3 = await addRate(supA, branchA, ana, '2026-10-20', '92.50');
    expect(r3.per_minute_display).toBe('1.5417');
    // Zero rate is refused by the database too, not only by validation.
    await expect(
      prisma.employeePayRate.create({ data: { employeeId: ana, branchId: branchA, effectiveFrom: new Date('2026-11-01'), hourlyRate: '0', reason: 'x', createdBy: ana, createdByName: 'x' } }),
    ).rejects.toThrow();
  });

  it('enforces branch scope server-side, including after an employee transfer', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await payrollService.savePolicy(supB, branchB, policyInput(0));
    await shift(dana, branchA, '2026-10-16 08:00', '2026-10-16 12:00');
    await shift(dana, branchB, '2026-10-21 08:00', '2026-10-21 16:00');

    // Supervisor B's stale JWT lists branch A; the DB says otherwise.
    await expectCode(payrollService.getSettings(supB, branchA), 'BRANCH_ACCESS_DENIED');
    await expectCode(payrollService.listRates(supB, branchA), 'BRANCH_ACCESS_DENIED');
    await expectCode(payrollService.getSettings(branchActor, branchA), 'INSUFFICIENT_PERMISSIONS');

    // Rates: each branch manages Dana's rate for time worked there only.
    const ratesA = await payrollService.listRates(supA, branchA);
    expect(ratesA.employees.find((e) => e.employee_id === dana)?.assignment).toBe('former');
    const ratesB = await payrollService.listRates(supB, branchB);
    expect(ratesB.employees.find((e) => e.employee_id === dana)?.assignment).toBe('current');
    expect(ratesB.employees.some((e) => e.employee_id === ana)).toBe(false);
    await expectCode(
      payrollService.createRate(supB, branchB, { employee_id: ana, effective_from: '2026-01-01', hourly_rate: '80', reason: 'not mine', expected_latest_rate_id: null }),
      'EMPLOYEE_NOT_IN_BRANCH',
    );
    const rateA = await addRate(supA, branchA, dana, '2026-01-01', '70');
    await addRate(supB, branchB, dana, '2026-01-01', '75');
    await expectCode(payrollService.voidRate(supB, branchB, rateA.id, { reason: 'reach across', expected_latest_rate_id: null }), 'RATE_NOT_FOUND');

    // Payroll: A's run has only Dana's A shift; B's only her B shift.
    const runA = (await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' })).run;
    const runB = (await payrollService.createRun(supB, branchB, { period_start: '2026-10-16', period_end: '2026-10-31' })).run;
    const detailA = await payrollService.getRun(supA, branchA, runA.id);
    const detailB = await payrollService.getRun(supB, branchB, runB.id);
    expect(detailA.employees.find((e) => e.employee_id === dana)?.calculated_total).toBe('280.00');
    expect(detailB.employees.find((e) => e.employee_id === dana)?.calculated_total).toBe('600.00');
    expect(detailA.employees.find((e) => e.employee_id === dana)?.shifts).toHaveLength(1);
    // A's run id through B's URL (or B's supervisor) is not found / denied — never another branch's data.
    await expectCode(payrollService.getRun(supB, branchB, runA.id), 'RUN_NOT_FOUND');
    await expectCode(payrollService.getRun(supB, branchA, runA.id), 'BRANCH_ACCESS_DENIED');
    // Super Admin: every branch.
    expect((await payrollService.getRun(admin, branchB, runB.id)).branch_name).toContain('P52 IT B');
    // Removing supervisor A's assignment removes access immediately (no stale JWT access).
    await prisma.userBranchAssignment.updateMany({ where: { userId: supA.user_id, branchId: branchA }, data: { removedAt: new Date() } });
    await expectCode(payrollService.getRun(supA, branchA, runA.id), 'BRANCH_ACCESS_DENIED');
    await prisma.userBranchAssignment.updateMany({ where: { userId: supA.user_id, branchId: branchA }, data: { removedAt: null } });
  });

  it('finalizes atomically, then stays unchanged when attendance, rates and policy change; CSV/PDF match the record', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    await addRate(supA, branchA, ben, '2026-01-01', '75.55');
    const anaShift = await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 17:00', 60);
    await shift(ben, branchA, '2026-10-17 08:00', '2026-10-17 15:59');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    await payrollService.addAdjustment(supA, branchA, run.id, { employee_id: ana, kind: 'earning', category: 'allowance', amount: '150.25', reason: 'Meal allowance' });
    await payrollService.addAdjustment(supA, branchA, run.id, { employee_id: ana, kind: 'deduction', category: 'documented_deduction', amount: '50', reason: 'Cash shortage', documentation_ref: 'Signed form #12' });
    const draft = await payrollService.getRun(supA, branchA, run.id);
    expect(draft.can_finalize).toBe(true);
    expect(draft.employees.find((e) => e.employee_id === ana)?.calculated_total).toBe('740.25'); // 640 + 150.25 − 50
    // Ben: 7h59m (479 min) at 75.55 = 603.14 (exact 603.1408…, rounded once).
    expect(draft.employees.find((e) => e.employee_id === ben)?.basic_pay).toBe('603.14');

    const finalized = await payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: draft.fingerprint as string, acknowledge_scope: true });
    expect(finalized.status).toBe('finalized');
    expect(finalized.calculated_total).toBe('1343.39');
    expect(await prisma.payrollAttendanceClaim.count({ where: { runId: run.id, releasedAt: null } })).toBe(2);
    const stored = await payrollService.getRun(supA, branchA, run.id);
    expect(stored.basis).toBe('finalized_snapshot');

    // Source edits after finalization.
    await addRate(supA, branchA, ana, '2026-10-01', '100');
    await payrollService.savePolicy(supA, branchA, policyInput(1, { break_treatment: 'paid' }));
    await attendanceService.manualOverride(anaShift.id, { clockOutServerTime: mnl('2026-10-16 20:00'), correctionReason: 'late clock-out' }, { id: supA.user_id, role: 'supervisor' });
    const after = await payrollService.getRun(supA, branchA, run.id);
    expect(after.totals).toEqual(stored.totals);
    expect(after.employees).toEqual(stored.employees);
    expect(after.policy?.break_treatment).toBe('unpaid');
    expect(after.source_changes.length).toBeGreaterThan(0);

    // Exports are built from the stored record.
    const csv = buildPayrollCsv(after).toString('utf-8');
    expect(csv).toContain('FINALIZED');
    const totalRow = csv.split('\r\n').find((l) => l.startsWith('TOTAL,'));
    expect(totalRow?.split(',').slice(5, 9)).toEqual([after.totals.basic_pay, after.totals.earnings_adjustments, after.totals.deductions, '1343.39']);
    const lines = await prisma.payrollRunLine.findMany({ where: { runId: run.id } });
    for (const line of lines) expect(csv).toContain(`,${line.calculatedTotal.toFixed(2)},FINALIZED`);
    const pdf = await buildPayrollPdf(after);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses a stale preview and writes nothing', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 12:00');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    const preview = await payrollService.getRun(supA, branchA, run.id);
    await shift(ana, branchA, '2026-10-18 08:00', '2026-10-18 10:00'); // attendance arrives after the review
    await expectCode(payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: preview.fingerprint as string, acknowledge_scope: true }), 'STALE_PREVIEW');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('draft');
    expect(await prisma.payrollRunLine.count({ where: { runId: run.id } })).toBe(0);
    const fresh = await payrollService.getRun(supA, branchA, run.id);
    expect(fresh.totals.calculated_total).toBe('480.00');
    await payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: fresh.fingerprint as string, acknowledge_scope: true });
  });

  it('lets exactly one of many concurrent finalizations win', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 12:00');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    const preview = await payrollService.getRun(supA, branchA, run.id);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: preview.fingerprint as string, acknowledge_scope: true })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect((r.reason as InstanceType<typeof PayrollError>).code).toBe('RUN_NOT_DRAFT');
    expect(await prisma.payrollRunLine.count({ where: { runId: run.id } })).toBe(1);
    expect(await prisma.payrollAttendanceClaim.count({ where: { runId: run.id } })).toBe(1);
  });

  it('prevents duplicate or overlapping finalized coverage', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    const record = await shift(ana, branchA, '2026-10-02 08:00', '2026-10-02 12:00');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-01', period_end: '2026-10-15' });
    const preview = await payrollService.getRun(supA, branchA, run.id);
    await payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: preview.fingerprint as string, acknowledge_scope: true });
    // Same period again → refused.
    await expectCode(payrollService.createRun(supA, branchA, { period_start: '2026-10-01', period_end: '2026-10-15' }), 'PERIOD_ALREADY_FINALIZED');
    // Switch to monthly: October overlaps the finalized 1–15 → refused.
    await payrollService.savePolicy(supA, branchA, policyInput(1, { period_type: 'monthly', semi_monthly_first_end_day: null }));
    await expectCode(payrollService.createRun(supA, branchA, { period_start: '2026-10-01', period_end: '2026-10-31' }), 'PERIOD_ALREADY_FINALIZED');
    // Database backstop: the same shift cannot hold two live claims.
    const other = await prisma.payrollRun.create({ data: { branchId: branchA, periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), createdBy: supA.user_id } });
    await expect(prisma.payrollAttendanceClaim.create({ data: { attendanceRecordId: record.id, runId: other.id, employeeId: ana } })).rejects.toThrow();
    // And two finalized runs for one branch+period are refused by the partial unique index.
    await expect(
      prisma.payrollRun.create({
        data: {
          branchId: branchA,
          periodStart: new Date('2026-10-01'),
          periodEnd: new Date('2026-10-15'),
          status: 'finalized',
          createdBy: supA.user_id,
          finalizedAt: new Date(),
          finalizedBy: supA.user_id,
          fingerprint: 'f'.repeat(64),
          policySnapshot: {},
          rateSnapshot: [],
          calculatedTotal: '0',
          scopeAcknowledgedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('blocks finalization on missing rates, open attendance and unresolved special pay; a resolution note unblocks', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 18:00'); // 10 h → possible overtime
    const open = await shift(ben, branchA, '2026-10-17 08:00', null);
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    let detail = await payrollService.getRun(supA, branchA, run.id);
    expect(detail.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['RATE_MISSING', 'OPEN_ATTENDANCE', 'POSSIBLE_OVERTIME']));
    await expectCode(payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: detail.fingerprint as string, acknowledge_scope: true }), 'BLOCKING_ISSUES');

    await addRate(supA, branchA, ana, '2026-01-01', '80');
    await addRate(supA, branchA, ben, '2026-01-01', '80');
    await prisma.attendanceRecord.update({ where: { id: open.id }, data: { clockOutServerTime: mnl('2026-10-17 12:00') } });
    detail = await payrollService.getRun(supA, branchA, run.id);
    const ot = detail.issues.find((i) => i.code === 'POSSIBLE_OVERTIME');
    expect(detail.can_finalize).toBe(false);
    await expectCode(payrollService.addResolution(supA, branchA, run.id, { issue_key: 'rate_missing:x', note: 'nope' }), 'ISSUE_NOT_RESOLVABLE');
    await payrollService.addResolution(supA, branchA, run.id, { issue_key: ot?.key as string, note: 'Approved 2h extension; premium via allowance' });
    await expectCode(payrollService.addResolution(supA, branchA, run.id, { issue_key: ot?.key as string, note: 'again' }), 'ISSUE_ALREADY_RESOLVED');
    detail = await payrollService.getRun(supA, branchA, run.id);
    expect(detail.can_finalize).toBe(true);
    await payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: detail.fingerprint as string, acknowledge_scope: true });
  });

  it('corrects through an audited revision, keeps Finalized separate from Paid, and never deletes', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    const s = await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 12:00');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    await payrollService.addAdjustment(supA, branchA, run.id, { employee_id: ana, kind: 'earning', category: 'bonus', amount: '20', reason: 'Perfect attendance' });
    const p1 = await payrollService.getRun(supA, branchA, run.id);
    await payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: p1.fingerprint as string, acknowledge_scope: true });
    await expectCode(payrollService.addAdjustment(supA, branchA, run.id, { employee_id: ana, kind: 'earning', category: 'bonus', amount: '1', reason: 'late add' }), 'RUN_NOT_DRAFT');

    const paid = await payrollService.markPaid(supA, branchA, run.id, 'GCash batch 7');
    expect(paid.status).toBe('finalized');
    expect(paid.paid_at).not.toBeNull();
    await expectCode(payrollService.markPaid(supA, branchA, run.id, undefined), 'NOT_PAYABLE');

    // Attendance corrected after payment → revise.
    await attendanceService.manualOverride(s.id, { clockOutServerTime: mnl('2026-10-16 13:00'), correctionReason: 'missed hour' }, { id: supA.user_id, role: 'supervisor' });
    const revision = await payrollService.revise(supA, branchA, run.id, 'Attendance correction for 16 Oct');
    await expectCode(payrollService.revise(supA, branchA, run.id, 'second one'), 'REVISION_EXISTS');
    const rd = await payrollService.getRun(supA, branchA, revision.id);
    const anaLine = rd.employees.find((e) => e.employee_id === ana);
    expect(anaLine?.adjustments[0]?.copied_from_id).not.toBeNull();
    expect(anaLine?.previous_total).toBe('340.00');
    expect(anaLine?.calculated_total).toBe('420.00');
    await payrollService.finalize(supA, branchA, revision.id, { expected_fingerprint: rd.fingerprint as string, acknowledge_scope: true });

    const original = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(original.status).toBe('superseded');
    expect(original.supersededById).toBe(revision.id);
    expect(original.calculatedTotal?.toFixed(2)).toBe('340.00');
    expect(await prisma.payrollRunLine.count({ where: { runId: run.id } })).toBe(1);
    expect(await prisma.payrollAttendanceClaim.count({ where: { runId: run.id, releasedAt: { not: null } } })).toBe(1);
    expect(await prisma.payrollAttendanceClaim.count({ where: { runId: revision.id, releasedAt: null } })).toBe(1);
    // A superseded run can't be revised or paid; the revision starts unpaid.
    await expectCode(payrollService.revise(supA, branchA, run.id, 'again'), 'RUN_NOT_FINALIZED');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: revision.id } })).paidAt).toBeNull();
    const audit = await prisma.auditOutbox.findMany({ where: { branchId: branchA, action: { startsWith: 'PAYROLL_' } }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['PAYROLL_FINALIZED', 'PAYROLL_MARKED_PAID', 'PAYROLL_REVISION_STARTED', 'PAYROLL_SUPERSEDED']));
  });

  it('reports only attendance written after finalization as a source change, never pre-existing non-staff attendance', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    const s = await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 12:00');
    const supShift = await shift(supA.user_id, branchA, '2026-10-17 08:00', '2026-10-17 12:00');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    const preview = await payrollService.getRun(supA, branchA, run.id);
    expect(preview.issues.some((i) => i.code === 'NON_STAFF_EXCLUDED')).toBe(true);
    await payrollService.finalize(supA, branchA, run.id, { expected_fingerprint: preview.fingerprint as string, acknowledge_scope: true });
    expect((await payrollService.getRun(supA, branchA, run.id)).source_changes).toEqual([]);
    await attendanceService.manualOverride(s.id, { clockOutServerTime: mnl('2026-10-16 12:30'), correctionReason: 'late clock-out' }, { id: supA.user_id, role: 'supervisor' });
    const changes = (await payrollService.getRun(supA, branchA, run.id)).source_changes;
    expect(changes.map((c) => c.attendance_record_id)).toContain(s.id);
    expect(changes.map((c) => c.attendance_record_id)).not.toContain(supShift.id);
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: supA.user_id } });
  });

  it('requires documented deductions at the database and refuses adjustments for employees outside the run', async () => {
    await payrollService.savePolicy(supA, branchA, policyInput(0));
    await addRate(supA, branchA, ana, '2026-01-01', '80');
    await shift(ana, branchA, '2026-10-16 08:00', '2026-10-16 12:00');
    const { run } = await payrollService.createRun(supA, branchA, { period_start: '2026-10-16', period_end: '2026-10-31' });
    await expectCode(
      payrollService.addAdjustment(supA, branchA, run.id, { employee_id: ben, kind: 'earning', category: 'allowance', amount: '10', reason: 'not here' }),
      'EMPLOYEE_NOT_IN_RUN',
    );
    await expect(
      prisma.payrollAdjustment.create({ data: { runId: run.id, employeeId: ana, kind: 'deduction', category: 'documented_deduction', amount: '5', reason: 'x', createdBy: ana, createdByName: 'x' } }),
    ).rejects.toThrow();
    const adj = await payrollService.addAdjustment(supA, branchA, run.id, { employee_id: ana, kind: 'deduction', category: 'documented_deduction', amount: '5', reason: 'Uniform', documentation_ref: 'Form 3' });
    await payrollService.voidAdjustment(supA, branchA, run.id, adj.id, 'entered by mistake');
    await expectCode(payrollService.voidAdjustment(supA, branchA, run.id, adj.id, 'again'), 'ADJUSTMENT_ALREADY_VOIDED');
    expect((await payrollService.getRun(supA, branchA, run.id)).totals.deductions).toBe('0.00');
    expect(await prisma.payrollAdjustment.count({ where: { runId: run.id } })).toBe(1);
  });
});
