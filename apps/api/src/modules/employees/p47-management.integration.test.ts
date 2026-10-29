import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P47 — against real Postgres:
 * - Permanent delete succeeds only for an account nothing refers to; an
 *   account with attendance / audit history is refused (409) and its
 *   history rows still resolve to the person's name afterwards.
 * - Supervisors cannot delete, edit or read PIN state outside their branch,
 *   and cannot act on a peer supervisor.
 * - The dashboard attendance summary is built from attendance records only
 *   and agrees with the Staff Clocked In KPI (branches.repository's rule).
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { employeesService } = await import('./employees.service.js');
const { attendanceService } = await import('../attendance/attendance.service.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { staffPinService } = await import('../staff-pin/staff-pin.service.js');

const HOUR = 60 * 60 * 1000;

describe.skipIf(!isLocalDatabase)('POS-PERF-P47 dashboard and management (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  let branchA: string;
  let branchB: string;
  let admin: JwtPayload;
  let supervisorA: JwtPayload;
  let peerSupervisorId: string;
  let unusedStaff: string;
  let workedStaff: string;
  let otherBranchStaff: string;
  let clockedOutStaff: string;
  let inactiveOpenStaff: string;

  async function makeUser(role: 'staff' | 'supervisor' | 'super_admin', label: string, extra: { isActive?: boolean } = {}) {
    const user = await prisma.user.create({
      data: {
        role,
        firstName: `P47${label}`,
        lastName: suffix,
        employmentType: 'regular',
        email: role === 'staff' ? null : `p47-${label}-${suffix}@test.local`,
        isActive: extra.isActive ?? true,
        status: extra.isActive === false ? 'inactive' : 'active',
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function assign(userId: string, branchId: string) {
    await prisma.userBranchAssignment.create({ data: { userId, branchId, assignedAt: new Date() } });
  }

  async function attendance(employeeId: string, branchId: string, clockIn: Date, clockOut: Date | null) {
    await prisma.attendanceRecord.create({
      data: { employeeId, branchId, clockInServerTime: clockIn, clockInGpsStatus: 'within_radius', clockOutServerTime: clockOut },
    });
  }

  beforeAll(async () => {
    for (const label of ['A', 'B']) {
      const branch = await prisma.branch.create({
        data: { name: `P47 Branch ${label} ${suffix}`, code: `P47${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
      });
      branchIds.push(branch.id);
    }
    [branchA, branchB] = branchIds as [string, string];

    const adminId = await makeUser('super_admin', 'admin');
    admin = { user_id: adminId, role: 'super_admin', email: `p47-admin-${suffix}@test.local` } as JwtPayload;
    const supervisorId = await makeUser('supervisor', 'supA');
    await assign(supervisorId, branchA);
    supervisorA = { user_id: supervisorId, role: 'supervisor', email: `p47-supA-${suffix}@test.local`, branch_ids: [branchA] } as JwtPayload;
    peerSupervisorId = await makeUser('supervisor', 'peer');
    await assign(peerSupervisorId, branchA);

    unusedStaff = await makeUser('staff', 'unused');
    workedStaff = await makeUser('staff', 'worked');
    otherBranchStaff = await makeUser('staff', 'otherBranch');
    clockedOutStaff = await makeUser('staff', 'clockedOut');
    inactiveOpenStaff = await makeUser('staff', 'inactiveOpen', { isActive: false });
    for (const id of [unusedStaff, workedStaff, clockedOutStaff, inactiveOpenStaff]) await assign(id, branchA);
    await assign(otherBranchStaff, branchB);

    const now = Date.now();
    // Overnight open record (may start on the previous Manila day) — still clocked in.
    await attendance(workedStaff, branchA, new Date(now - 20 * HOUR), null);
    // Clocked in and out within the last hour — today in Manila for any run.
    await attendance(clockedOutStaff, branchA, new Date(now - 50 * 60 * 1000), new Date(now - 10 * 60 * 1000));
    // Open row for a deactivated employee — must not count as clocked in.
    await attendance(inactiveOpenStaff, branchA, new Date(now - 2 * HOUR), null);
    await attendance(otherBranchStaff, branchB, new Date(now - HOUR), null);
  });

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.staffPin.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: userIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  describe('attendance summary', () => {
    it('lists only currently working staff as clocked in and today’s clock-outs separately, matching the KPI', async () => {
      const summary = await attendanceService.getBranchSummary(branchA);
      expect(summary.clocked_in.map((r) => r.employee_id)).toEqual([workedStaff]);
      expect(summary.clocked_out_today.map((r) => r.employee_id)).toEqual([clockedOutStaff]);
      expect(summary.excluded_open_count).toBe(1);

      const stats = await branchesRepository.branchStats(branchA);
      expect(stats.staffTimedInCount).toBe(summary.clocked_in.length);
    });

    it('never mixes another branch’s records in', async () => {
      const summary = await attendanceService.getBranchSummary(branchB);
      expect(summary.clocked_in.map((r) => r.employee_id)).toEqual([otherBranchStaff]);
      expect(summary.clocked_out_today).toEqual([]);
    });
  });

  describe('delete versus deactivate', () => {
    it('reports an unused staff member as deletable and one with attendance as history-bound', async () => {
      await expect(employeesService.getDeletionEligibility(unusedStaff, supervisorA)).resolves.toMatchObject({ can_delete: true });
      const worked = await employeesService.getDeletionEligibility(workedStaff, supervisorA);
      expect(worked).toMatchObject({ can_delete: false, blocked_reason: 'has_history' });
      expect(worked.references.attendance).toBeGreaterThan(0);
    });

    it('refuses to delete a staff member with attendance and leaves their records attributed', async () => {
      await expect(employeesService.deleteEmployee(workedStaff, supervisorA, null)).rejects.toMatchObject({
        code: 'EMPLOYEE_HAS_HISTORY',
        statusCode: 409,
      });
      const record = await prisma.attendanceRecord.findFirst({
        where: { employeeId: workedStaff },
        include: { employee: { select: { firstName: true } } },
      });
      expect(record?.employee.firstName).toBe('P47worked');
    });

    it('rejects cross-branch delete and peer-supervisor delete before touching data', async () => {
      await expect(employeesService.deleteEmployee(otherBranchStaff, supervisorA, null)).rejects.toMatchObject({
        code: 'EMPLOYEE_ACCESS_DENIED',
      });
      await expect(employeesService.deleteEmployee(peerSupervisorId, supervisorA, null)).rejects.toMatchObject({
        code: 'TARGET_ROLE_FORBIDDEN',
      });
      expect(await prisma.user.count({ where: { id: { in: [otherBranchStaff, peerSupervisorId] } } })).toBe(2);
    });

    it('permanently deletes an unused staff member (with a PIN) and keeps a named audit entry', async () => {
      await staffPinService.setPin(unusedStaff, '482915', supervisorA, null);
      await employeesService.deleteEmployee(unusedStaff, supervisorA, null);

      expect(await prisma.user.findUnique({ where: { id: unusedStaff } })).toBeNull();
      expect(await prisma.staffPin.count({ where: { userId: unusedStaff } })).toBe(0);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'EMPLOYEE_DELETED', entityId: unusedStaff } });
      expect(audit?.actorId).toBe(supervisorA.user_id);
      expect(JSON.stringify(audit?.beforeState)).toContain('P47unused');
    });

    it('turns a former deletable person into history-bound once they act (audit actor)', async () => {
      // supervisorA acted above (PIN set, deletion audit) — super_admin may
      // manage supervisors but must not destroy that attribution.
      const result = await employeesService.getDeletionEligibility(supervisorA.user_id, admin);
      expect(result.can_delete).toBe(false);
      expect(result.references.audit).toBeGreaterThan(0);
      // The peer supervisor never acted — deletable by super_admin only.
      await expect(employeesService.getDeletionEligibility(peerSupervisorId, admin)).resolves.toMatchObject({ can_delete: true });
    });
  });

  describe('PIN status scope', () => {
    it('rejects a supervisor reading PIN state for staff outside their branches', async () => {
      await expect(staffPinService.getStatus(otherBranchStaff, supervisorA)).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });
      await expect(staffPinService.getStatus(workedStaff, supervisorA)).resolves.toMatchObject({ has_pin: false });
      await expect(staffPinService.getStatus(otherBranchStaff, admin)).resolves.toMatchObject({ has_pin: false });
    });
  });
});
