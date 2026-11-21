import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P64 — Super Admin "Delete" of a supervisor with history, against
 * real Postgres (local disposable database only):
 * - access ends everywhere (login, refresh, PIN, existing access tokens,
 *   branch access) and no ordinary endpoint can give it back;
 * - every history row still names the person; nothing is cascaded;
 * - open shifts / clock-ins block with no partial change;
 * - repeated and concurrent requests are safe;
 * - exact-ID fixture cleanup removes only the reviewed accounts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { employeesService } = await import('./employees.service.js');
const { authService } = await import('../auth/auth.service.js');
const { branchesService } = await import('../branches/branches.service.js');
const { attendanceService } = await import('../attendance/attendance.service.js');
const { verifyAccessToken, removedAccountRevocationHash } = await import('../../lib/verify-access-token.js');
const { runFixtureCleanup } = await import('./fixture-account-cleanup.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const PASSWORD = 'P64-Sup3r!pass';
const HOUR = 60 * 60 * 1000;

type ErrorWithCode = { code?: string };
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ErrorWithCode).code ?? (error instanceof Error ? error.message : 'unknown');
  }
}

describe.skipIf(!isLocalDatabase)('POS-PERF-P64 account removal keeping history (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  let branchA: string;
  let branchB: string;
  let admin: JwtPayload;
  let passwordHash: string;

  async function makeUser(role: 'staff' | 'supervisor' | 'super_admin', label: string) {
    const user = await prisma.user.create({
      data: {
        role,
        firstName: `P64${label}`,
        lastName: suffix,
        employmentType: 'regular',
        email: role === 'staff' ? null : `p64-${label}-${suffix}@test.local`.toLowerCase(),
        passwordHash: role === 'staff' ? null : passwordHash,
        mustChangePassword: false,
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function assign(userId: string, branchId: string) {
    await prisma.userBranchAssignment.create({ data: { userId, branchId, assignedAt: new Date() } });
  }

  /** A supervisor with real history: a closed shift, a closed attendance record and an audit entry. */
  async function supervisorWithHistory(label: string, branchId: string) {
    const user = await makeUser('supervisor', label);
    await assign(user.id, branchId);
    await prisma.shift.create({
      data: { branchId, cashierId: user.id, openedBy: user.id, closedBy: user.id, status: 'closed', openingCashAmount: 500, startedAt: new Date(Date.now() - 6 * HOUR) },
    });
    await prisma.attendanceRecord.create({
      data: {
        employeeId: user.id,
        branchId,
        clockInServerTime: new Date(Date.now() - 5 * HOUR),
        clockOutServerTime: new Date(Date.now() - HOUR),
        clockInGpsStatus: 'within_radius',
      },
    });
    await recordAuditLog({ action: 'P64_TEST_ACTION', entityType: 'test', entityId: user.id, actorId: user.id, actorRole: 'supervisor' });
    return user;
  }

  async function loginAs(email: string, deviceId: string) {
    const result = await authService.login(email, PASSWORD, deviceId, null);
    if (!('access_token' in result)) throw new Error('unexpected 2FA challenge');
    return result;
  }

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 12);
    for (const label of ['A', 'B']) {
      const branch = await prisma.branch.create({
        data: { name: `P64 Branch ${label} ${suffix}`, code: `P64${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
      });
      branchIds.push(branch.id);
    }
    [branchA, branchB] = branchIds as [string, string];
    const adminUser = await makeUser('super_admin', 'admin');
    admin = { user_id: adminUser.id, role: 'super_admin', email: adminUser.email } as JwtPayload;
  });

  afterAll(async () => {
    await prisma.revokedToken.deleteMany({ where: { tokenHash: { in: userIds.map(removedAccountRevocationHash) } } });
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.shift.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.pinCredential.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: userIds } }] } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  describe('removal of a supervisor with history', () => {
    let sup: Awaited<ReturnType<typeof makeUser>>;
    let session: Awaited<ReturnType<typeof loginAs>>;
    const deviceId = `p64-device-${randomUUID()}`;
    const historyBefore: Record<string, number> = {};

    beforeAll(async () => {
      sup = await supervisorWithHistory('removed', branchA);
      session = await loginAs(sup.email as string, deviceId);
      await authService.setPin(sup.id, deviceId, '246810');
      await prisma.passwordResetToken.create({
        data: { tokenHash: `p64-reset-${suffix}`, userId: sup.id, expiresAt: new Date(Date.now() + HOUR) },
      });
      historyBefore.shifts = await prisma.shift.count({ where: { cashierId: sup.id } });
      historyBefore.attendance = await prisma.attendanceRecord.count({ where: { employeeId: sup.id } });
      historyBefore.audit = await prisma.auditLog.count({ where: { actorId: sup.id } });

      // Before: the access token works and the account is listed.
      await expect(verifyAccessToken(session.access_token)).resolves.toMatchObject({ user_id: sup.id });
    });

    it('explains the removal (history kept, branch left uncovered) before acting', async () => {
      const eligibility = await employeesService.getDeletionEligibility(sup.id, admin);
      expect(eligibility).toMatchObject({ can_delete: true, blocked_reason: null, mode: 'remove_keep_history' });
      expect(eligibility.references.shifts).toBeGreaterThan(0);
      expect(eligibility.prerequisites?.branches.map((b) => b.id)).toEqual([branchA]);
      expect(eligibility.prerequisites?.branches_left_without_supervisor.map((b) => b.id)).toEqual([branchA]);
    });

    it('removes the account and keeps every history row naming the person', async () => {
      const result = await employeesService.deleteEmployee(sup.id, admin, null);
      expect(result).toEqual({ deleted: true, outcome: 'removed' });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedBy).toBe(admin.user_id);
      expect(row.isActive).toBe(false);
      expect(row.status).toBe('inactive');
      expect(row.firstName).toBe('P64removed');
      expect(row.email).toBe(sup.email);

      expect(await prisma.shift.count({ where: { cashierId: sup.id } })).toBe(historyBefore.shifts);
      expect(await prisma.attendanceRecord.count({ where: { employeeId: sup.id } })).toBe(historyBefore.attendance);
      expect(await prisma.auditLog.count({ where: { actorId: sup.id } })).toBeGreaterThanOrEqual(historyBefore.audit as number);

      // A historical attendance listing still shows the real name.
      const history = await attendanceService.getByBranch(branchA, { page: 1, limit: 50 });
      const rows = history.records as unknown as { employee_id: string; employee_name?: string; first_name?: string }[];
      const mine = rows.find((r) => r.employee_id === sup.id);
      expect(mine).toBeDefined();
      expect(JSON.stringify(mine)).toContain('P64removed');

      const audit = await prisma.auditLog.findFirst({ where: { entityId: sup.id, action: 'EMPLOYEE_REMOVED' } });
      expect(audit?.actorId).toBe(admin.user_id);
    });

    it('ends sessions, refresh, PIN, reset tokens and branch access', async () => {
      expect(await prisma.refreshToken.count({ where: { userId: sup.id, revokedAt: null } })).toBe(0);
      expect(await prisma.pinCredential.count({ where: { userId: sup.id } })).toBe(0);
      expect(await prisma.passwordResetToken.count({ where: { userId: sup.id } })).toBe(0);
      expect(await prisma.userBranchAssignment.count({ where: { userId: sup.id, removedAt: null } })).toBe(0);

      expect(await codeOf(verifyAccessToken(session.access_token))).toBe('TOKEN_REVOKED');
      expect(await codeOf(authService.refreshToken(session.refreshToken, deviceId))).toBe('REFRESH_INVALID');
      expect(await codeOf(authService.login(sup.email as string, PASSWORD, deviceId, null))).toBe('ACCOUNT_INACTIVE');
      expect(await codeOf(authService.validatePin(sup.id, deviceId, '246810'))).toBeDefined();
      expect(await codeOf(authService.resetPassword(`p64-reset-${suffix}`, 'N3w!Password'))).toBe('RESET_TOKEN_INVALID');
      await authService.requestPasswordReset(sup.email as string);
      expect(await prisma.passwordResetToken.count({ where: { userId: sup.id } })).toBe(0);
    });

    it('cannot be revived through status, reactivation, edit, reset, assignment or unlock', async () => {
      expect(await codeOf(employeesService.setEmployeeStatus(sup.id, 'active', null, admin, null))).toBe('EMPLOYEE_REMOVED');
      expect(await codeOf(employeesService.reactivateEmployee(sup.id, admin, null))).toBe('EMPLOYEE_REMOVED');
      expect(await codeOf(employeesService.updateEmployee(sup.id, { first_name: 'Back' }, admin, null))).toBe('EMPLOYEE_REMOVED');
      expect(await codeOf(employeesService.updateEmployee(sup.id, { branch_ids: [branchB] }, admin, null))).toBe('EMPLOYEE_REMOVED');
      expect(await codeOf(employeesService.resetEmployeePassword(sup.id, undefined, admin, null))).toBe('EMPLOYEE_REMOVED');
      expect(await codeOf(employeesService.deactivateEmployee(sup.id, { reason: 'again and again', acknowledge_active_shift: false }, admin, null))).toBe('EMPLOYEE_REMOVED');
      expect(await codeOf(branchesService.assignSupervisor(sup.id, branchB, { id: admin.user_id, role: 'super_admin' }, null))).toBe('USER_REMOVED');
      expect(await codeOf(authService.unlockAccount(sup.id, { id: admin.user_id, role: 'super_admin' }, null))).toBe('ACCOUNT_REMOVED');

      // Database backstop — what an older API version's reactivate would do after a rollback.
      expect(await codeOf(prisma.user.update({ where: { id: sup.id }, data: { isActive: true, status: 'active' } }))).toBeDefined();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id } });
      expect(row.isActive).toBe(false);
      expect(await prisma.userBranchAssignment.count({ where: { userId: sup.id, removedAt: null } })).toBe(0);
    });

    it('is absent from operational lists and searches but distinguishable from an inactive account', async () => {
      const list = await employeesService.getAllEmployees(admin, { role: 'supervisor', page: 1, limit: 100 });
      expect(list.employees.map((e) => e.id)).not.toContain(sup.id);
      const search = await employeesService.getAllEmployees(admin, { search: `P64removed`, page: 1, limit: 100 });
      expect(search.total).toBe(0);
      const inactiveOnly = await employeesService.getAllEmployees(admin, { isActive: false, search: suffix, page: 1, limit: 100 });
      expect(inactiveOnly.employees.map((e) => e.id)).not.toContain(sup.id);
    });

    it('a repeated delete is safe and audited', async () => {
      const again = await employeesService.deleteEmployee(sup.id, admin, null);
      expect(again).toEqual({ deleted: true, outcome: 'already_removed' });
      expect(await prisma.auditLog.count({ where: { entityId: sup.id, action: 'EMPLOYEE_REMOVAL_REPEATED' } })).toBe(1);
      const eligibility = await employeesService.getDeletionEligibility(sup.id, admin);
      expect(eligibility).toMatchObject({ can_delete: false, blocked_reason: 'already_removed' });
    });
  });

  describe('authorization', () => {
    it('refuses supervisors, self-removal and Super Admin targets, and keeps staff-with-history refused', async () => {
      const target = await supervisorWithHistory('authTarget', branchA);
      const actorSup = await makeUser('supervisor', 'authActor');
      await assign(actorSup.id, branchA);
      const supervisorActor = { user_id: actorSup.id, role: 'supervisor', email: actorSup.email, branch_ids: [branchA] } as JwtPayload;
      expect(await codeOf(employeesService.deleteEmployee(target.id, supervisorActor, null))).toBe('TARGET_ROLE_FORBIDDEN');
      expect(await codeOf(employeesService.deleteEmployee(admin.user_id, admin, null))).toBe('PRIVILEGED_ACCOUNT_PROTECTED');
      const otherAdmin = await makeUser('super_admin', 'otherAdmin');
      expect(await codeOf(employeesService.deleteEmployee(otherAdmin.id, admin, null))).toBe('PRIVILEGED_ACCOUNT_PROTECTED');

      const staff = await makeUser('staff', 'workedStaff');
      await assign(staff.id, branchA);
      await prisma.attendanceRecord.create({
        data: { employeeId: staff.id, branchId: branchA, clockInServerTime: new Date(Date.now() - 3 * HOUR), clockOutServerTime: new Date(Date.now() - 2 * HOUR), clockInGpsStatus: 'within_radius' },
      });
      expect(await codeOf(employeesService.deleteEmployee(staff.id, admin, null))).toBe('EMPLOYEE_HAS_HISTORY');

      expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).deletedAt).toBeNull();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).deletedAt).toBeNull();
    });
  });

  describe('open-operation safeguards', () => {
    it('refuses while a shift or clock-in is open and changes nothing', async () => {
      const sup = await supervisorWithHistory('openWork', branchB);
      const deviceId = `p64-open-${randomUUID()}`;
      const session = await loginAs(sup.email as string, deviceId);
      const shift = await prisma.shift.create({ data: { branchId: branchB, cashierId: sup.id, openedBy: sup.id, status: 'active', openingCashAmount: 300, startedAt: new Date() } });
      const open = await prisma.attendanceRecord.create({
        data: { employeeId: sup.id, branchId: branchB, clockInServerTime: new Date(Date.now() - HOUR), clockInGpsStatus: 'within_radius' },
      });

      const eligibility = await employeesService.getDeletionEligibility(sup.id, admin);
      expect(eligibility).toMatchObject({ can_delete: false, blocked_reason: 'open_operations' });
      expect(await codeOf(employeesService.deleteEmployee(sup.id, admin, null))).toBe('EMPLOYEE_HAS_OPEN_OPERATIONS');

      const row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id } });
      expect(row.deletedAt).toBeNull();
      expect(row.isActive).toBe(true);
      expect(row.status).toBe('active');
      expect(await prisma.userBranchAssignment.count({ where: { userId: sup.id, removedAt: null } })).toBe(1);
      expect(await prisma.refreshToken.count({ where: { userId: sup.id, revokedAt: null } })).toBe(1);
      expect(await prisma.revokedToken.count({ where: { tokenHash: removedAccountRevocationHash(sup.id) } })).toBe(0);
      await expect(verifyAccessToken(session.access_token)).resolves.toMatchObject({ user_id: sup.id });
      expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe('active');

      // Closed through the normal workflow, removal then goes through.
      await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedBy: sup.id } });
      await prisma.attendanceRecord.update({ where: { id: open.id }, data: { clockOutServerTime: new Date() } });
      expect(await employeesService.deleteEmployee(sup.id, admin, null)).toEqual({ deleted: true, outcome: 'removed' });
    });
  });

  describe('concurrency', () => {
    it('two simultaneous deletes remove once and report the repeat', async () => {
      const sup = await supervisorWithHistory('race', branchA);
      const results = await Promise.all([
        employeesService.deleteEmployee(sup.id, admin, null),
        employeesService.deleteEmployee(sup.id, admin, null),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['already_removed', 'removed']);
      expect(await prisma.auditLog.count({ where: { entityId: sup.id, action: 'EMPLOYEE_REMOVED' } })).toBe(1);
    });

    it('a racing reactivation, branch assignment or login cannot leave a removed account with access', async () => {
      const sup = await supervisorWithHistory('raceRevive', branchA);
      await prisma.user.update({ where: { id: sup.id }, data: { isActive: false, status: 'inactive' } });
      const deviceId = `p64-race-${randomUUID()}`;
      const settled = await Promise.allSettled([
        employeesService.deleteEmployee(sup.id, admin, null),
        employeesService.setEmployeeStatus(sup.id, 'active', null, admin, null),
        branchesService.assignSupervisor(sup.id, branchB, { id: admin.user_id, role: 'super_admin' }, null),
        authService.login(sup.email as string, PASSWORD, deviceId, null),
      ]);
      expect(settled[0].status).toBe('fulfilled');

      const row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.isActive).toBe(false);
      expect(row.status).not.toBe('active');
      expect(await prisma.userBranchAssignment.count({ where: { userId: sup.id, removedAt: null } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: sup.id, revokedAt: null } })).toBeLessThanOrEqual(1);
      const login = settled[3];
      if (login.status === 'fulfilled' && 'access_token' in login.value) {
        // A login that won the race holds tokens that are already dead.
        expect(await codeOf(verifyAccessToken(login.value.access_token))).toBe('TOKEN_REVOKED');
        expect(await codeOf(authService.refreshToken(login.value.refreshToken, deviceId))).toBe('REFRESH_INVALID');
      }
    });
  });

  describe('exact-ID fixture cleanup', () => {
    it('dry run changes nothing; execution removes only reviewed fixtures and refuses mismatches and protected accounts', async () => {
      const fixtureSup = await supervisorWithHistory('fixtureSup', branchB);
      const fixtureUnused = await makeUser('supervisor', 'fixtureUnused');
      const realSup = await supervisorWithHistory('realSup', branchB);
      const adminFixture = await makeUser('super_admin', 'fixtureAdmin');
      const manifest = {
        actor_user_id: admin.user_id,
        accounts: [
          { id: fixtureSup.id, email: fixtureSup.email as string, role: 'supervisor' as const, evidence: 'local P64 test fixture with history' },
          { id: fixtureUnused.id, email: fixtureUnused.email as string, role: 'supervisor' as const, evidence: 'local P64 test fixture, never used' },
          // Wrong email for a real person: must be refused, never acted on.
          { id: realSup.id, email: `someone-else-${suffix}@test.local`, role: 'supervisor' as const, evidence: 'deliberately mismatched entry' },
          { id: adminFixture.id, email: adminFixture.email as string, role: 'super_admin' as const, evidence: 'protected super admin fixture' },
        ],
      };

      const dry = await runFixtureCleanup(manifest, { execute: false, token: 't' });
      expect(dry.actor.ok).toBe(true);
      expect(dry.accounts.map((a) => a.action)).toEqual(['remove_keep_history', 'permanent_delete', 'refused', 'refused']);
      expect(dry.accounts[0]?.history?.shifts).toBeGreaterThan(0);
      expect(dry.accounts[0]?.branches).toHaveLength(1);
      expect(await prisma.user.count({ where: { id: { in: [fixtureSup.id, fixtureUnused.id] }, deletedAt: null } })).toBe(2);

      const run = await runFixtureCleanup(manifest, { execute: true, token: 't' });
      expect(run.accounts.map((a) => a.outcome)).toEqual(['removed', 'permanent', 'skipped', 'skipped']);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: fixtureSup.id } })).deletedAt).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: fixtureUnused.id } })).toBeNull();
      const real = await prisma.user.findUniqueOrThrow({ where: { id: realSup.id } });
      expect(real.deletedAt).toBeNull();
      expect(real.isActive).toBe(true);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: adminFixture.id } })).deletedAt).toBeNull();
      expect(await prisma.shift.count({ where: { cashierId: fixtureSup.id } })).toBe(1);

      const repeat = await runFixtureCleanup(manifest, { execute: true, token: 't' });
      expect(repeat.accounts[0]?.outcome).toBe('already_removed');
    });

    it('refuses everything when the actor is not an active Super Admin', async () => {
      const notAdmin = await makeUser('supervisor', 'fakeActor');
      const fixture = await makeUser('supervisor', 'fixtureNoActor');
      const run = await runFixtureCleanup(
        { actor_user_id: notAdmin.id, accounts: [{ id: fixture.id, email: fixture.email as string, role: 'supervisor', evidence: 'local P64 test fixture' }] },
        { execute: true, token: 't' },
      );
      expect(run.actor.ok).toBe(false);
      expect(run.accounts[0]?.outcome).toBe('skipped');
      expect(await prisma.user.findUnique({ where: { id: fixture.id } })).not.toBeNull();
    });
  });
});
