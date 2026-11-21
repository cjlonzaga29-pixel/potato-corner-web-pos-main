import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P66 — Delete permanently removes the account, against real
 * Postgres (local disposable database only):
 * - the users row, credentials, sessions, PINs and branch access are gone;
 * - every history row stays, still attributed to the real name through the
 *   person's attribution record (people), with amounts unchanged;
 * - history never blocks; open shifts, clock-ins and unpaid payroll hours do,
 *   with nothing changed;
 * - the confirmation is checked server-side (typed name + account version);
 * - repeated, concurrent and lost-response requests are safe;
 * - a new account never inherits the deleted one's identity or access;
 * - exact-ID fixture cleanup deletes only the reviewed accounts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { employeesService } = await import('./employees.service.js');
const { authService } = await import('../auth/auth.service.js');
const { attendanceService } = await import('../attendance/attendance.service.js');
const { auditService } = await import('../audit/audit.service.js');
const { verifyAccessToken } = await import('../../lib/verify-access-token.js');
const { runFixtureCleanup } = await import('./fixture-account-cleanup.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const PASSWORD = 'P66-Sup3r!pass';
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

describe.skipIf(!isLocalDatabase)('POS-PERF-P66 permanent account deletion keeping history (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  let branchA: string;
  let branchB: string;
  let admin: JwtPayload;
  let passwordHash: string;

  async function makeUser(role: 'staff' | 'supervisor' | 'super_admin' | 'branch', label: string) {
    const user = await prisma.user.create({
      data: {
        role,
        firstName: `P66${label}`,
        lastName: suffix,
        employmentType: 'regular',
        email: role === 'staff' ? null : `p66-${label}-${suffix}@test.local`.toLowerCase(),
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

  async function confirmationFor(id: string, actor: JwtPayload) {
    const eligibility = await employeesService.getDeletionEligibility(id, actor);
    if (!eligibility.confirmation) throw new Error(`no confirmation offered (${eligibility.blocked_reason ?? 'none'})`);
    return { confirm_name: eligibility.confirmation.name, version: eligibility.confirmation.version };
  }

  /** A supervisor with history across FK'd and plain-id tables, including ones P47 did not count. */
  async function supervisorWithHistory(label: string, branchId: string) {
    const user = await makeUser('supervisor', label);
    await assign(user.id, branchId);
    const shift = await prisma.shift.create({
      data: { branchId, cashierId: user.id, openedBy: user.id, closedBy: user.id, status: 'closed', openingCashAmount: 500, startedAt: new Date(Date.now() - 6 * HOUR) },
    });
    await prisma.attendanceRecord.create({
      data: { employeeId: user.id, branchId, clockInServerTime: new Date(Date.now() - 5 * HOUR), clockOutServerTime: new Date(Date.now() - HOUR), clockInGpsStatus: 'within_radius' },
    });
    await prisma.expense.create({ data: { branchId, category: 'supplies', amount: 123.45, incurredAt: new Date(), createdBy: user.id } });
    await prisma.expenseType.create({ data: { name: `P66 type ${label} ${suffix}`, normalizedName: `p66 type ${label} ${suffix}`.toLowerCase(), createdById: user.id } });
    await prisma.transaction.create({
      data: {
        transactionNumber: `P66-${label}-${suffix}`,
        branchId,
        shiftId: shift.id,
        cashierId: user.id,
        voidedById: user.id,
        paymentMethod: 'cash',
        subtotal: 250,
        vatAmount: 0,
        totalAmount: 250,
      },
    });
    await recordAuditLog({ action: 'P66_TEST_ACTION', entityType: 'test', entityId: user.id, actorId: user.id, actorRole: 'supervisor', branchId });
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
        data: { name: `P66 Branch ${label} ${suffix}`, code: `P66${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
      });
      branchIds.push(branch.id);
    }
    [branchA, branchB] = branchIds as [string, string];
    const adminUser = await makeUser('super_admin', 'admin');
    admin = { user_id: adminUser.id, role: 'super_admin', email: adminUser.email } as JwtPayload;
  });

  // No afterAll: the database is disposable, sales are immutable (CR-004) and
  // the attribution records are referenced by the history this file creates.

  it('reproduced failure: a supervisor whose only history is an uncounted FK (expense type) is deleted, not a 500', async () => {
    const sup = await makeUser('supervisor', 'onlyType');
    await prisma.expenseType.create({ data: { name: `P66 only ${suffix}`, normalizedName: `p66 only ${suffix}`, createdById: sup.id } });
    const eligibility = await employeesService.getDeletionEligibility(sup.id, admin);
    expect(eligibility).toMatchObject({ can_delete: true, mode: 'permanent' });
    expect(eligibility.references?.expenses).toBe(1);
    await expect(employeesService.deleteEmployee(sup.id, admin, null, await confirmationFor(sup.id, admin))).resolves.toEqual({
      deleted: true,
      outcome: 'deleted',
    });
    const type = await prisma.expenseType.findFirstOrThrow({ where: { createdById: sup.id }, include: { creator: { select: { firstName: true } } } });
    expect(type.creator.firstName).toBe('P66onlyType');
  });

  describe('deleting a supervisor with history', () => {
    let sup: Awaited<ReturnType<typeof makeUser>>;
    let session: Awaited<ReturnType<typeof loginAs>>;
    const deviceId = `p66-device-${randomUUID()}`;
    const before: Record<string, unknown> = {};

    beforeAll(async () => {
      sup = await supervisorWithHistory('deleted', branchA);
      session = await loginAs(sup.email as string, deviceId);
      await authService.setPin(sup.id, deviceId, '246810');
      await prisma.passwordResetToken.create({ data: { tokenHash: `p66-reset-${suffix}`, userId: sup.id, expiresAt: new Date(Date.now() + HOUR) } });
      before.shifts = await prisma.shift.count({ where: { OR: [{ cashierId: sup.id }, { openedBy: sup.id }, { closedBy: sup.id }] } });
      before.attendance = await prisma.attendanceRecord.count({ where: { employeeId: sup.id } });
      before.audit = await prisma.auditLog.count({ where: { actorId: sup.id } });
      before.expense = await prisma.expense.findFirstOrThrow({ where: { createdBy: sup.id } });
      before.sale = await prisma.transaction.findFirstOrThrow({ where: { cashierId: sup.id } });
    });

    it('cancellation (no request) and a wrong typed name or stale version change nothing', async () => {
      const confirmation = await confirmationFor(sup.id, admin);
      expect(confirmation.confirm_name).toBe(`P66deleted ${suffix}`);
      expect(await codeOf(employeesService.deleteEmployee(sup.id, admin, null, { ...confirmation, confirm_name: 'P66deleted' }))).toBe(
        'DELETE_CONFIRMATION_MISMATCH',
      );
      expect(await codeOf(employeesService.deleteEmployee(sup.id, admin, null, { ...confirmation, version: new Date(0).toISOString() }))).toBe(
        'EMPLOYEE_CHANGED',
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id } });
      expect(row.isActive).toBe(true);
      await expect(verifyAccessToken(session.access_token)).resolves.toMatchObject({ user_id: sup.id });
    });

    it('removes the account row and everything that belonged to it', async () => {
      const result = await employeesService.deleteEmployee(sup.id, admin, null, await confirmationFor(sup.id, admin));
      expect(result).toEqual({ deleted: true, outcome: 'deleted' });
      expect(await prisma.user.findUnique({ where: { id: sup.id } })).toBeNull();
      expect(await prisma.user.count({ where: { email: sup.email } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: sup.id } })).toBe(0);
      expect(await prisma.pinCredential.count({ where: { userId: sup.id } })).toBe(0);
      expect(await prisma.passwordResetToken.count({ where: { userId: sup.id } })).toBe(0);
      expect(await prisma.userBranchAssignment.count({ where: { userId: sup.id } })).toBe(0);
      const person = await prisma.person.findUniqueOrThrow({ where: { id: sup.id } });
      expect(person).toMatchObject({ firstName: 'P66deleted', role: 'supervisor', accountDeletedBy: admin.user_id });
      expect(person.accountDeletedAt).not.toBeNull();
      // The attribution record carries no credentials or contact details.
      expect(Object.keys(person).sort()).toEqual(
        ['accountDeletedAt', 'accountDeletedBy', 'createdAt', 'employeeCode', 'firstName', 'id', 'lastName', 'role'].sort(),
      );
    });

    it('keeps every history row, its attribution and its amounts', async () => {
      expect(await prisma.shift.count({ where: { OR: [{ cashierId: sup.id }, { openedBy: sup.id }, { closedBy: sup.id }] } })).toBe(before.shifts);
      expect(await prisma.attendanceRecord.count({ where: { employeeId: sup.id } })).toBe(before.attendance);
      expect(await prisma.auditLog.count({ where: { actorId: sup.id } })).toBe(before.audit);
      const sale = await prisma.transaction.findFirstOrThrow({ where: { cashierId: sup.id }, include: { cashier: true, voidedBy: true } });
      expect(sale.voidedById).toBe(sup.id); // formerly ON DELETE SET NULL: would have been erased
      expect(sale.cashier.firstName).toBe('P66deleted');
      expect(sale.voidedBy?.firstName).toBe('P66deleted');
      expect(sale.totalAmount.toString()).toBe((before.sale as { totalAmount: { toString(): string } }).totalAmount.toString());
      const expense = await prisma.expense.findFirstOrThrow({ where: { createdBy: sup.id }, include: { creator: true } });
      expect(expense.amount.toString()).toBe((before.expense as { amount: { toString(): string } }).amount.toString());
      expect(expense.creator.firstName).toBe('P66deleted');

      const attendance = await attendanceService.getByBranch(branchA, { page: 1, limit: 50 });
      const mine = (attendance.records as unknown as { employee_id: string; employee_name: string | null; employee_status: string | null }[]).find(
        (r) => r.employee_id === sup.id,
      );
      expect(mine?.employee_name).toBe(`P66deleted ${suffix}`);
      expect(mine?.employee_status).toBeNull();

      const audit = await auditService.listLogs({ actorId: sup.id, page: 1, limit: 20 } as never, admin);
      const entry = audit.logs.find((log) => log.action === 'P66_TEST_ACTION');
      expect(entry?.actor).toMatchObject({ first_name: 'P66deleted', email: null, account_deleted: true });
      const deletion = await prisma.auditLog.findFirstOrThrow({ where: { entityId: sup.id, action: 'EMPLOYEE_DELETED' } });
      expect(deletion.actorId).toBe(admin.user_id);
      expect(JSON.stringify(deletion.beforeState)).not.toContain(sup.email as string);
    });

    it('denies login, refresh, stale access tokens, PIN and password reset', async () => {
      expect(await codeOf(verifyAccessToken(session.access_token))).toBe('TOKEN_REVOKED');
      expect(await codeOf(authService.refreshToken(session.refreshToken, deviceId))).toBeDefined();
      expect(await codeOf(authService.login(sup.email as string, PASSWORD, deviceId, null))).toBeDefined();
      expect(await codeOf(authService.validatePin(sup.id, deviceId, '246810'))).toBeDefined();
      expect(await codeOf(authService.resetPassword(`p66-reset-${suffix}`, 'N3w!Password'))).toBe('RESET_TOKEN_INVALID');
      await authService.requestPasswordReset(sup.email as string);
      expect(await prisma.passwordResetToken.count({ where: { userId: sup.id } })).toBe(0);
    });

    it('a repeat after a lost response reports already_deleted (audited); other actors get 404', async () => {
      const repeat = await employeesService.deleteEmployee(sup.id, admin, null, { confirm_name: 'anything', version: new Date().toISOString() });
      expect(repeat).toEqual({ deleted: true, outcome: 'already_deleted' });
      expect(await prisma.auditLog.count({ where: { entityId: sup.id, action: 'EMPLOYEE_DELETION_REPEATED' } })).toBe(1);
      await expect(employeesService.getDeletionEligibility(sup.id, admin)).resolves.toMatchObject({ blocked_reason: 'already_deleted' });
      const other = await makeUser('supervisor', 'otherSup');
      await assign(other.id, branchA);
      const otherActor = { user_id: other.id, role: 'supervisor', email: other.email, branch_ids: [branchA] } as JwtPayload;
      expect(await codeOf(employeesService.deleteEmployee(sup.id, otherActor, null, { confirm_name: 'x', version: new Date().toISOString() }))).toBe(
        'EMPLOYEE_NOT_FOUND',
      );
    });

    it('a new account with the same email gets a new identity and none of the old access', async () => {
      const fresh = await prisma.user.create({
        data: { role: 'supervisor', firstName: 'P66fresh', lastName: suffix, employmentType: 'regular', email: sup.email, passwordHash, mustChangePassword: false },
      });
      userIds.push(fresh.id);
      expect(fresh.id).not.toBe(sup.id);
      expect(await prisma.userBranchAssignment.count({ where: { userId: fresh.id } })).toBe(0);
      expect(await codeOf(verifyAccessToken(session.access_token))).toBe('TOKEN_REVOKED');
      const freshSession = await loginAs(sup.email as string, `p66-fresh-${randomUUID()}`);
      await expect(verifyAccessToken(freshSession.access_token)).resolves.toMatchObject({ user_id: fresh.id });
      // History stays with the deleted person, never the new account.
      const sale = await prisma.transaction.findFirstOrThrow({ where: { transactionNumber: `P66-deleted-${suffix}` } });
      expect(sale.cashierId).toBe(sup.id);
      // The deleted account's id can never be reused.
      expect(
        await codeOf(
          prisma.user.create({ data: { id: sup.id, role: 'supervisor', firstName: 'Reuse', lastName: suffix, employmentType: 'regular', email: `p66-reuse-${suffix}@test.local` } }),
        ),
      ).toBeDefined();
      expect(await prisma.user.findUnique({ where: { id: sup.id } })).toBeNull();
    });
  });

  describe('authorization and protected accounts', () => {
    it('refuses peer supervisors, self, Super Admins, branch accounts and other branches, changing nothing', async () => {
      const target = await supervisorWithHistory('authTarget', branchA);
      const actorSup = await makeUser('supervisor', 'authActor');
      await assign(actorSup.id, branchA);
      const supervisorActor = { user_id: actorSup.id, role: 'supervisor', email: actorSup.email, branch_ids: [branchA] } as JwtPayload;
      const any = { confirm_name: 'x', version: new Date().toISOString() };
      expect(await codeOf(employeesService.deleteEmployee(target.id, supervisorActor, null, any))).toBe('TARGET_ROLE_FORBIDDEN');
      expect(await codeOf(employeesService.deleteEmployee(actorSup.id, supervisorActor, null, any))).toBe('SELF_ACTION_FORBIDDEN');
      expect(await codeOf(employeesService.deleteEmployee(admin.user_id, admin, null, any))).toBe('PRIVILEGED_ACCOUNT_PROTECTED');
      const otherAdmin = await makeUser('super_admin', 'otherAdmin');
      expect(await codeOf(employeesService.deleteEmployee(otherAdmin.id, admin, null, any))).toBe('PRIVILEGED_ACCOUNT_PROTECTED');
      const branchAccount = await makeUser('branch', 'branchAcct');
      await assign(branchAccount.id, branchA);
      expect(await codeOf(employeesService.deleteEmployee(branchAccount.id, admin, null, any))).toBe('BRANCH_ACCOUNT_NOT_DELETABLE');
      const otherBranchStaff = await makeUser('staff', 'otherBranchStaff');
      await assign(otherBranchStaff.id, branchB);
      expect(await codeOf(employeesService.deleteEmployee(otherBranchStaff.id, supervisorActor, null, any))).toBe('EMPLOYEE_ACCESS_DENIED');
      expect(await prisma.user.count({ where: { id: { in: [target.id, actorSup.id, otherAdmin.id, branchAccount.id, otherBranchStaff.id] } } })).toBe(5);
    });

    it('a supervisor deletes a staff member with history at their branch', async () => {
      const actorSup = await makeUser('supervisor', 'staffDeleter');
      await assign(actorSup.id, branchA);
      const supervisorActor = { user_id: actorSup.id, role: 'supervisor', email: actorSup.email, branch_ids: [branchA] } as JwtPayload;
      const staff = await makeUser('staff', 'workedStaff');
      await assign(staff.id, branchA);
      await prisma.attendanceRecord.create({
        data: { employeeId: staff.id, branchId: branchA, clockInServerTime: new Date(Date.now() - 3 * HOUR), clockOutServerTime: new Date(Date.now() - 2 * HOUR), clockInGpsStatus: 'within_radius' },
      });
      const result = await employeesService.deleteEmployee(staff.id, supervisorActor, null, await confirmationFor(staff.id, supervisorActor));
      expect(result.outcome).toBe('deleted');
      expect(await prisma.attendanceRecord.count({ where: { employeeId: staff.id } })).toBe(1);
    });
  });

  describe('prerequisites block with nothing changed', () => {
    it('an open shift and an open clock-in block; resolved through the normal workflow, delete goes through', async () => {
      const sup = await supervisorWithHistory('openWork', branchB);
      const deviceId = `p66-open-${randomUUID()}`;
      const session = await loginAs(sup.email as string, deviceId);
      const shift = await prisma.shift.create({ data: { branchId: branchB, cashierId: sup.id, openedBy: sup.id, status: 'active', openingCashAmount: 300, startedAt: new Date() } });
      const open = await prisma.attendanceRecord.create({
        data: { employeeId: sup.id, branchId: branchB, clockInServerTime: new Date(Date.now() - HOUR), clockInGpsStatus: 'within_radius' },
      });
      const eligibility = await employeesService.getDeletionEligibility(sup.id, admin);
      expect(eligibility).toMatchObject({ can_delete: false, blocked_reason: 'open_operations' });
      const confirmation = { confirm_name: eligibility.confirmation?.name ?? '', version: eligibility.confirmation?.version ?? '' };
      const error = await employeesService.deleteEmployee(sup.id, admin, null, confirmation).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'EMPLOYEE_HAS_OPEN_OPERATIONS' });
      expect((error as Error).message).toContain('close the open shift');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id } });
      expect(row.isActive).toBe(true);
      expect(await prisma.userBranchAssignment.count({ where: { userId: sup.id, removedAt: null } })).toBe(1);
      expect(await prisma.refreshToken.count({ where: { userId: sup.id, revokedAt: null } })).toBe(1);
      expect((await prisma.person.findUniqueOrThrow({ where: { id: sup.id } })).accountDeletedAt).toBeNull();
      await expect(verifyAccessToken(session.access_token)).resolves.toMatchObject({ user_id: sup.id });

      await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedBy: sup.id } });
      await prisma.attendanceRecord.update({ where: { id: open.id }, data: { clockOutServerTime: new Date() } });
      expect(await employeesService.deleteEmployee(sup.id, admin, null, await confirmationFor(sup.id, admin))).toEqual({ deleted: true, outcome: 'deleted' });
    });

    it('staff hours at a payroll branch that no finalized payroll covers block until finalized', async () => {
      const staff = await makeUser('staff', 'unpaid');
      await assign(staff.id, branchB);
      await prisma.payrollPolicy.create({
        data: { branchId: branchB, version: 1, timezone: 'Asia/Manila', periodType: 'semi_monthly', breakTreatment: 'unpaid', createdBy: admin.user_id, createdByName: 'Admin', createdAt: new Date(Date.now() - 48 * HOUR) },
      });
      const clockIn = new Date(Date.now() - 26 * HOUR);
      await prisma.attendanceRecord.create({
        data: { employeeId: staff.id, branchId: branchB, clockInServerTime: clockIn, clockOutServerTime: new Date(clockIn.getTime() + 4 * HOUR), clockInGpsStatus: 'within_radius' },
      });
      await prisma.employeePayRate.create({
        data: { employeeId: staff.id, branchId: branchB, effectiveFrom: new Date(Date.now() - 72 * HOUR), hourlyRate: 80, reason: 'P66 test', createdBy: admin.user_id, createdByName: 'Admin' },
      });
      const eligibility = await employeesService.getDeletionEligibility(staff.id, admin);
      expect(eligibility).toMatchObject({ can_delete: false, blocked_reason: 'open_operations' });
      expect(eligibility.prerequisites?.unpaid_payroll).toHaveLength(1);
      const confirmation = { confirm_name: eligibility.confirmation?.name ?? '', version: eligibility.confirmation?.version ?? '' };
      const error = await employeesService.deleteEmployee(staff.id, admin, null, confirmation).catch((e: unknown) => e);
      expect((error as Error).message).toContain(`finalize payroll at P66 Branch B ${suffix}`);
      expect(await prisma.user.findUnique({ where: { id: staff.id } })).not.toBeNull();

      const day = eligibility.prerequisites?.unpaid_payroll[0]?.first_date as string;
      await prisma.payrollRun.create({
        data: {
          branchId: branchB,
          periodStart: new Date(`${day}T00:00:00Z`),
          periodEnd: new Date(`${day}T00:00:00Z`),
          status: 'finalized',
          createdBy: admin.user_id,
          finalizedAt: new Date(),
          finalizedBy: admin.user_id,
          fingerprint: 'p66-test',
          policySnapshot: {},
          rateSnapshot: {},
          calculatedTotal: 320,
          scopeAcknowledgedAt: new Date(),
        } as never,
      });
      expect(await employeesService.deleteEmployee(staff.id, admin, null, await confirmationFor(staff.id, admin))).toMatchObject({ outcome: 'deleted' });
      expect(await prisma.employeePayRate.count({ where: { employeeId: staff.id } })).toBe(1);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous deletes delete once and report the repeat', async () => {
      const sup = await supervisorWithHistory('race', branchA);
      const confirmation = await confirmationFor(sup.id, admin);
      const results = await Promise.all([
        employeesService.deleteEmployee(sup.id, admin, null, confirmation),
        employeesService.deleteEmployee(sup.id, admin, null, confirmation),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['already_deleted', 'deleted']);
      expect(await prisma.auditLog.count({ where: { entityId: sup.id, action: 'EMPLOYEE_DELETED' } })).toBe(1);
    });

    it('a racing edit or login never leaves a deleted account with access or a half-deleted account', async () => {
      const sup = await supervisorWithHistory('raceLogin', branchA);
      const confirmation = await confirmationFor(sup.id, admin);
      const deviceId = `p66-race-${randomUUID()}`;
      const settled = await Promise.allSettled([
        employeesService.deleteEmployee(sup.id, admin, null, confirmation),
        employeesService.updateEmployee(sup.id, { phone: '09170000000' } as never, admin, null),
        authService.login(sup.email as string, PASSWORD, deviceId, null),
      ]);
      const row = await prisma.user.findUnique({ where: { id: sup.id } });
      if (settled[0].status === 'fulfilled') {
        // Deleted: nothing of the account is left, and any won login holds dead tokens.
        expect(row).toBeNull();
        expect(await prisma.refreshToken.count({ where: { userId: sup.id } })).toBe(0);
        const login = settled[2];
        if (login.status === 'fulfilled' && 'access_token' in login.value) {
          expect(await codeOf(verifyAccessToken(login.value.access_token))).toBe('TOKEN_REVOKED');
        }
      } else {
        // The edit won and changed the version: the delete refused and changed nothing.
        expect(settled[0].reason).toMatchObject({ code: 'EMPLOYEE_CHANGED' });
        expect(row).not.toBeNull();
        expect((await prisma.person.findUniqueOrThrow({ where: { id: sup.id } })).accountDeletedAt).toBeNull();
      }
    });
  });

  describe('legacy P64-removed row', () => {
    it('is deleted for good by a Super Admin', async () => {
      const sup = await supervisorWithHistory('legacyRemoved', branchA);
      await prisma.userBranchAssignment.updateMany({ where: { userId: sup.id }, data: { removedAt: new Date() } });
      await prisma.user.update({ where: { id: sup.id }, data: { isActive: false, status: 'inactive', deletedAt: new Date(), deletedBy: admin.user_id } });
      expect(await employeesService.deleteEmployee(sup.id, admin, null, await confirmationFor(sup.id, admin))).toMatchObject({ outcome: 'deleted' });
      expect(await prisma.user.findUnique({ where: { id: sup.id } })).toBeNull();
      expect(await prisma.shift.count({ where: { cashierId: sup.id } })).toBe(1);
    });
  });

  describe('exact-ID fixture cleanup', () => {
    it('dry run changes nothing; execution deletes only reviewed fixtures and refuses mismatches and protected accounts', async () => {
      const fixtureSup = await supervisorWithHistory('fixtureSup', branchB);
      const fixtureStaff = await makeUser('staff', 'fixtureStaff');
      await assign(fixtureStaff.id, branchB);
      const realSup = await supervisorWithHistory('realSup', branchB);
      const legitimateFixture = await supervisorWithHistory('keepFixture', branchB);
      const adminFixture = await makeUser('super_admin', 'fixtureAdmin');
      const manifest = {
        actor_user_id: admin.user_id,
        accounts: [
          { id: fixtureSup.id, email: fixtureSup.email, role: 'supervisor' as const, evidence: 'local P66 test fixture with history' },
          { id: fixtureStaff.id, email: null, name: `P66fixtureStaff ${suffix}`, role: 'staff' as const, evidence: 'local P66 staff fixture' },
          { id: realSup.id, email: `someone-else-${suffix}@test.local`, role: 'supervisor' as const, evidence: 'deliberately mismatched entry' },
          { id: adminFixture.id, email: adminFixture.email, role: 'super_admin' as const, evidence: 'protected super admin fixture' },
        ],
      };

      const dry = await runFixtureCleanup(manifest, { execute: false, token: 't' });
      expect(dry.actor.ok).toBe(true);
      expect(dry.accounts.map((a) => a.action)).toEqual(['permanent_delete', 'permanent_delete', 'refused', 'refused']);
      expect(dry.accounts[0]?.history?.shifts).toBeGreaterThan(0);
      expect(await prisma.user.count({ where: { id: { in: [fixtureSup.id, fixtureStaff.id] } } })).toBe(2);

      const run = await runFixtureCleanup(manifest, { execute: true, token: 't' });
      expect(run.accounts.map((a) => a.outcome)).toEqual(['deleted', 'deleted', 'skipped', 'skipped']);
      expect(await prisma.user.count({ where: { id: { in: [fixtureSup.id, fixtureStaff.id] } } })).toBe(0);
      expect(await prisma.user.count({ where: { id: { in: [realSup.id, legitimateFixture.id, adminFixture.id] } } })).toBe(3);
      expect(await prisma.shift.count({ where: { cashierId: fixtureSup.id } })).toBe(1);

      const repeat = await runFixtureCleanup(manifest, { execute: true, token: 't' });
      expect(repeat.accounts.slice(0, 2).map((a) => a.outcome)).toEqual(['already_deleted', 'already_deleted']);
    });
  });
});
