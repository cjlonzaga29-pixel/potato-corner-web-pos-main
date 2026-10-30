import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * POS-PERF-P51 — real-Postgres coverage for break intervals: concurrent and
 * repeated Start Break / Resume / Clock Out create no duplicate or
 * overlapping intervals, the partial unique index and check constraints hold
 * at the database, clock-out closes an open break at the same timestamp,
 * shiftGuard refuses an on-break employee, and the branch summary stays
 * branch-isolated. Same safety convention as staff-pin.integration.test.ts —
 * only runs against a loopback DATABASE_URL, never Supabase/production.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

vi.mock('../../lib/notify.js', () => ({ notifyBranch: vi.fn(), notifySuperAdmin: vi.fn() }));

const { prisma } = await import('../../lib/prisma.js');
const { attendanceService } = await import('./attendance.service.js');
const { shiftGuard } = await import('../../middleware/shift-guard.js');

describe.skipIf(!isLocalDatabase)('attendance breaks integration (real Postgres)', () => {
  const tag = randomUUID().slice(0, 8);
  let branchAId: string;
  let branchBId: string;
  let employeeAId: string;
  let employeeBId: string;
  let setupSucceeded = false;

  async function openRecord(employeeId: string, branchId: string) {
    return prisma.attendanceRecord.create({
      data: {
        employeeId,
        branchId,
        clockInServerTime: new Date(Date.now() - 4 * 3600_000),
        clockInGpsLat: 14.6,
        clockInGpsLng: 121.0,
        clockInGpsStatus: 'within_radius',
      },
    });
  }

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.branch.create({ data: { name: `P51 IT A ${tag}`, code: `P51A${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } }),
      prisma.branch.create({ data: { name: `P51 IT B ${tag}`, code: `P51B${tag}`.slice(0, 20), address: 'x', city: 'x', status: 'active' } }),
    ]);
    branchAId = a.id;
    branchBId = b.id;
    const [ea, eb] = await Promise.all([
      prisma.user.create({ data: { role: 'staff', firstName: 'Ana', lastName: `IT${tag}`, employeeId: `P51A-${tag}`, employmentType: 'regular' } }),
      prisma.user.create({ data: { role: 'staff', firstName: 'Ben', lastName: `IT${tag}`, employeeId: `P51B-${tag}`, employmentType: 'regular' } }),
    ]);
    employeeAId = ea.id;
    employeeBId = eb.id;
    await prisma.userBranchAssignment.createMany({
      data: [
        { userId: employeeAId, branchId: branchAId },
        { userId: employeeBId, branchId: branchBId },
      ],
    });
    setupSucceeded = true;
  });

  beforeEach(async () => {
    if (!setupSucceeded) return;
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [employeeAId, employeeBId] } } });
  });

  afterAll(async () => {
    if (!setupSucceeded) return;
    await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [employeeAId, employeeBId] } } });
    // shiftGuard auto-opens a shift on the first allowed request; the audit
    // log is append-only and is left alone.
    await prisma.shift.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: [employeeAId, employeeBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [employeeAId, employeeBId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
  });

  const actorA = () => ({ id: employeeAId, role: 'staff' });

  it('10 concurrent Start Break requests create exactly one open interval; the rest get ALREADY_ON_BREAK', async () => {
    const record = await openRecord(employeeAId, branchAId);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => attendanceService.startBreak(employeeAId, branchAId, actorA())));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(9);
    for (const r of rejected) expect((r.reason as { code: string }).code).toBe('ALREADY_ON_BREAK');
    expect(await prisma.attendanceBreak.count({ where: { attendanceRecordId: record.id } })).toBe(1);
  });

  it('the database itself refuses a second open break on the same record (partial unique index)', async () => {
    const record = await openRecord(employeeAId, branchAId);
    await prisma.attendanceBreak.create({ data: { attendanceRecordId: record.id, startedAt: new Date(), startedBy: employeeAId } });
    await expect(
      prisma.attendanceBreak.create({ data: { attendanceRecordId: record.id, startedAt: new Date(), startedBy: employeeAId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('the database refuses an interval that ends before it starts, or an end without a reason', async () => {
    const record = await openRecord(employeeAId, branchAId);
    const start = new Date();
    await expect(
      prisma.attendanceBreak.create({
        data: { attendanceRecordId: record.id, startedAt: start, endedAt: new Date(start.getTime() - 1000), endReason: 'resumed', startedBy: employeeAId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.attendanceBreak.create({ data: { attendanceRecordId: record.id, startedAt: start, endedAt: start, startedBy: employeeAId } }),
    ).rejects.toThrow();
  });

  it('10 concurrent Resume requests end the break exactly once; the rest get NOT_ON_BREAK; same record, no new clock-in', async () => {
    const record = await openRecord(employeeAId, branchAId);
    await attendanceService.startBreak(employeeAId, branchAId, actorA());
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => attendanceService.endBreak(employeeAId, branchAId, actorA())));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { code: string }).code).toBe('NOT_ON_BREAK');
    const breaks = await prisma.attendanceBreak.findMany({ where: { attendanceRecordId: record.id } });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.endReason).toBe('resumed');
    expect(await prisma.attendanceRecord.count({ where: { employeeId: employeeAId, deletedAt: null } })).toBe(1);
  });

  it('repeated start → resume cycles produce ordered, non-overlapping intervals', async () => {
    const record = await openRecord(employeeAId, branchAId);
    for (let i = 0; i < 3; i++) {
      await attendanceService.startBreak(employeeAId, branchAId, actorA());
      await attendanceService.endBreak(employeeAId, branchAId, actorA());
    }
    const breaks = await prisma.attendanceBreak.findMany({ where: { attendanceRecordId: record.id }, orderBy: { startedAt: 'asc' } });
    expect(breaks).toHaveLength(3);
    breaks.forEach((current, i) => {
      const previousEnd = breaks[i - 1]?.endedAt;
      if (i > 0) {
        expect(previousEnd).toBeInstanceOf(Date);
        expect(current.startedAt.getTime()).toBeGreaterThanOrEqual(previousEnd?.getTime() ?? Number.POSITIVE_INFINITY);
      }
    });
  });

  it('clock-out during a break closes the break at exactly the clock-out timestamp, atomically', async () => {
    const record = await openRecord(employeeAId, branchAId);
    await attendanceService.startBreak(employeeAId, branchAId, actorA());
    const result = await attendanceService.clockOut(employeeAId, {}, actorA());

    const closed = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id }, include: { breaks: true } });
    expect(closed.clockOutServerTime).not.toBeNull();
    expect(closed.breaks).toHaveLength(1);
    expect(closed.breaks[0]?.endReason).toBe('clock_out');
    expect(closed.breaks[0]?.endedAt?.getTime()).toBe(closed.clockOutServerTime?.getTime());
    expect(result.attendance_state).toBe('clocked_out');
    expect(result.breaks[0]?.end_reason).toBe('clock_out');
  });

  it('Start Break racing Clock Out never leaves an open break on a closed record', async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.attendanceRecord.deleteMany({ where: { employeeId: employeeAId } });
      const record = await openRecord(employeeAId, branchAId);
      await Promise.allSettled([attendanceService.startBreak(employeeAId, branchAId, actorA()), attendanceService.clockOut(employeeAId, {}, actorA())]);
      const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id }, include: { breaks: true } });
      if (after.clockOutServerTime) {
        expect(after.breaks.every((b) => b.endedAt !== null)).toBe(true);
      }
    }
  });

  it('a second concurrent clock-out does not overwrite the first (404 under the lock)', async () => {
    await openRecord(employeeAId, branchAId);
    const results = await Promise.allSettled([attendanceService.clockOut(employeeAId, {}, actorA()), attendanceService.clockOut(employeeAId, {}, actorA())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((rejected?.reason as { code: string }).code).toBe('RECORD_NOT_FOUND');
  });

  it('shiftGuard refuses checkout for an employee on break (ON_BREAK) and allows it again after Resume', async () => {
    await openRecord(employeeAId, branchAId);
    await attendanceService.startBreak(employeeAId, branchAId, actorA());

    const makeReq = () =>
      ({ user: { user_id: employeeAId, role: 'staff', email: null, branch_ids: [branchAId], iat: 0, exp: 9999999999 }, params: {}, query: {}, body: { branch_id: branchAId }, headers: {} }) as unknown as Request;
    const makeRes = () => {
      const captured = { statusCode: 200, body: undefined as unknown };
      const res = {
        status(code: number) {
          captured.statusCode = code;
          return res;
        },
        json(body: unknown) {
          captured.body = body;
          return res;
        },
      };
      return Object.assign(res as unknown as Response, { captured });
    };

    const onBreakRes = makeRes();
    const blockedNext = vi.fn() as unknown as NextFunction;
    await shiftGuard(makeReq(), onBreakRes, blockedNext);
    expect(onBreakRes.captured.statusCode).toBe(403);
    expect((onBreakRes.captured.body as { error: { code: string } }).error.code).toBe('ON_BREAK');
    expect(blockedNext).not.toHaveBeenCalled();

    await attendanceService.endBreak(employeeAId, branchAId, actorA());
    const next = vi.fn() as unknown as NextFunction;
    await shiftGuard(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('Start Break is refused at another branch, and the summary is branch-isolated', async () => {
    await openRecord(employeeAId, branchAId);
    await openRecord(employeeBId, branchBId);
    await expect(attendanceService.startBreak(employeeAId, branchBId, actorA())).rejects.toMatchObject({ code: 'NOT_CLOCKED_IN' });
    await attendanceService.startBreak(employeeAId, branchAId, actorA());

    const summaryA = await attendanceService.getBranchSummary(branchAId);
    const summaryB = await attendanceService.getBranchSummary(branchBId);
    expect(summaryA.clocked_in.map((r) => r.employee_id)).toEqual([employeeAId]);
    expect(summaryA.on_break_count).toBe(1);
    expect(summaryA.clocked_in[0]?.attendance_state).toBe('on_break');
    expect(summaryB.clocked_in.map((r) => r.employee_id)).toEqual([employeeBId]);
    expect(summaryB.on_break_count).toBe(0);
  });
});
