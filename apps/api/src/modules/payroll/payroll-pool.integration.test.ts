import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P54 — the locked payroll writes must not need a second pooled
 * connection while holding the branch lock. With a pool smaller than the
 * number of concurrent reviewers, the waiters each hold a connection, so a
 * lock holder that reads anything outside its transaction starves until the
 * pool timeout (P2024) instead of the waiters getting 409. The pool is capped
 * at 2 for this file only (its own module registry). Loopback DATABASE_URL only.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));

process.env.DATABASE_URL = `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=2`;
const { prisma } = await import('../../lib/prisma.js');
const { payrollService } = await import('./payroll.service.js');
const { PayrollError } = await import('./payroll.types.js');
process.env.DATABASE_URL = databaseUrl;

function mnl(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+08:00`);
}

const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason instanceof PayrollError ? r.reason.code : String((r.reason as { code?: string }).code ?? r.reason)) : 'ok');

describe.skipIf(!isLocalDatabase)('payroll locked writes with a small connection pool (real Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  let branchId: string;
  let ana: string;
  let sup: JwtPayload;
  const userIds: string[] = [];

  async function clean() {
    const runs = await prisma.payrollRun.findMany({ where: { branchId }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await prisma.payrollAttendanceClaim.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRunLine.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollIssueResolution.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.employeePayRate.deleteMany({ where: { branchId } });
    await prisma.payrollPolicy.deleteMany({ where: { branchId } });
    await prisma.attendanceRecord.deleteMany({ where: { branchId } });
  }

  beforeAll(async () => {
    branchId = (await prisma.branch.create({ data: { name: `P54 pool ${tag}`, code: `P54P${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } })).id;
    const uAna = await prisma.user.create({ data: { role: 'staff', firstName: 'Ana', lastName: `Pool${tag}`, employeeId: `P54P-A-${tag}`, employmentType: 'regular' } });
    const uSup = await prisma.user.create({ data: { role: 'supervisor', firstName: 'Sup', lastName: `Pool${tag}`, employeeId: `P54P-S-${tag}`, employmentType: 'regular', email: `sup-${tag}@p54.test` } });
    ana = uAna.id;
    userIds.push(ana, uSup.id);
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: ana, branchId, assignedAt: new Date('2026-01-01T00:00:00Z') },
        { userId: uSup.id, branchId, assignedAt: new Date('2026-01-01T00:00:00Z') },
      ],
    });
    sup = { user_id: uSup.id, role: 'supervisor', email: uSup.email as string, branch_ids: [branchId], iat: 0, exp: 9_999_999_999 } as JwtPayload;
    await payrollService.savePolicy(sup, branchId, { timezone: 'Asia/Manila', period_type: 'semi_monthly', semi_monthly_first_end_day: 15, break_treatment: 'unpaid', paid_break_limit_minutes: null, expected_version: 0 });
    await payrollService.createRate(sup, branchId, { employee_id: ana, effective_from: '2026-01-01', hourly_rate: '80', reason: 'pool test', expected_latest_rate_id: null });
    // An overnight shift → one night-hours (special pay) issue to resolve.
    await prisma.attendanceRecord.create({
      data: { employeeId: ana, branchId, clockInServerTime: mnl('2026-10-16 22:00'), clockOutServerTime: mnl('2026-10-17 06:00'), clockInGpsStatus: 'within_radius' },
    });
  });

  afterAll(async () => {
    await clean();
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.delete({ where: { id: branchId } });
  });

  it('five concurrent resolution notes and six concurrent finalizations: one wins each, the rest get 409 — never a pool timeout', async () => {
    const { run } = await payrollService.createRun(sup, branchId, { period_start: '2026-10-16', period_end: '2026-10-31' });
    const draft = await payrollService.getRun(sup, branchId, run.id);
    const night = draft.issues.find((i) => i.code === 'NIGHT_HOURS');
    expect(night).toBeDefined();

    const notes = await Promise.allSettled(Array.from({ length: 5 }, () => payrollService.addResolution(sup, branchId, run.id, { issue_key: night?.key as string, note: 'approved night shift' })));
    expect(notes.map(codeOf).sort()).toEqual(['ISSUE_ALREADY_RESOLVED', 'ISSUE_ALREADY_RESOLVED', 'ISSUE_ALREADY_RESOLVED', 'ISSUE_ALREADY_RESOLVED', 'ok']);

    const preview = await payrollService.getRun(sup, branchId, run.id);
    expect(preview.can_finalize).toBe(true);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => payrollService.finalize(sup, branchId, run.id, { expected_fingerprint: preview.fingerprint as string, acknowledge_scope: true })),
    );
    expect(results.map(codeOf).sort()).toEqual(['RUN_NOT_DRAFT', 'RUN_NOT_DRAFT', 'RUN_NOT_DRAFT', 'RUN_NOT_DRAFT', 'RUN_NOT_DRAFT', 'ok']);
    expect(await prisma.payrollAttendanceClaim.count({ where: { runId: run.id } })).toBe(1);
  }, 60_000);
});
