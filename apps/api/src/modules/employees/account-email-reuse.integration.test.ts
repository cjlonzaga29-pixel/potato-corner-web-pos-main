import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * Account deletion releases the email; nothing else does. Against real
 * Postgres (local disposable database only), through the services:
 * - a deleted account's email (any letter case) creates a NEW account with a
 *   new id, fresh credentials and none of the old sessions, PIN, access or history;
 * - reports keep attributing the old activity to the original person;
 * - a working or merely inactive account keeps its email (case-insensitive);
 * - simultaneous creates, and a create racing a delete, never leave two
 *   holders or a 500.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { employeesService } = await import('./employees.service.js');
const { authService } = await import('../auth/auth.service.js');
const { reportsRepository } = await import('../reports/reports.repository.js');
const { verifyAccessToken } = await import('../../lib/verify-access-token.js');

const PASSWORD = 'Reuse-Sup3r!pass';
const HOUR = 60 * 60 * 1000;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? (error instanceof Error ? error.message : 'unknown');
  }
}

describe.skipIf(!isLocalDatabase)('account deletion releases the email for a fresh account (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  let branchId: string;
  let admin: JwtPayload;
  let passwordHash: string;

  const emailFor = (label: string) => `reuse-${label}-${suffix}@test.local`.toLowerCase();

  function createSupervisor(email: string, firstName: string) {
    return employeesService.createEmployee(
      {
        email,
        first_name: firstName,
        last_name: suffix,
        role: 'supervisor',
        employment_type: 'regular',
        branch_ids: [branchId],
        initial_password: PASSWORD,
      } as never,
      admin,
      null,
    );
  }

  async function deleteAccount(id: string) {
    const eligibility = await employeesService.getDeletionEligibility(id, admin);
    if (!eligibility.confirmation) throw new Error(`not deletable (${eligibility.blocked_reason ?? 'none'})`);
    return employeesService.deleteEmployee(id, admin, null, {
      confirm_name: eligibility.confirmation.name,
      version: eligibility.confirmation.version,
    });
  }

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 12);
    branchId = (
      await prisma.branch.create({
        data: { name: `Reuse Branch ${suffix}`, code: `REU-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
      })
    ).id;
    const adminUser = await prisma.user.create({
      data: {
        role: 'super_admin',
        firstName: 'ReuseAdmin',
        lastName: suffix,
        employmentType: 'regular',
        email: emailFor('admin'),
        passwordHash,
        mustChangePassword: false,
      },
    });
    admin = { user_id: adminUser.id, role: 'super_admin', email: adminUser.email } as JwtPayload;
  }, 60_000);

  // No afterAll: the database is disposable and sales are immutable (CR-004).

  describe('an account with history is deleted, then the email is used again', () => {
    const email = emailFor('history');
    let oldId: string;
    let oldSession: Awaited<ReturnType<typeof authService.login>>;
    const oldDevice = `reuse-old-${randomUUID()}`;
    const receipt = `REUSE-${suffix}`;

    beforeAll(async () => {
      oldId = (await createSupervisor(email, 'Original')).id;
      await prisma.user.update({ where: { id: oldId }, data: { mustChangePassword: false } });
      oldSession = await authService.login(email, PASSWORD, oldDevice, null);
      await authService.setPin(oldId, oldDevice, '135790');
      const shift = await prisma.shift.create({
        data: { branchId, cashierId: oldId, openedBy: oldId, closedBy: oldId, status: 'closed', openingCashAmount: 500, startedAt: new Date(Date.now() - 4 * HOUR) },
      });
      await prisma.attendanceRecord.create({
        data: { employeeId: oldId, branchId, clockInServerTime: new Date(Date.now() - 3 * HOUR), clockOutServerTime: new Date(Date.now() - HOUR), clockInGpsStatus: 'within_radius' },
      });
      await prisma.transaction.create({
        data: { transactionNumber: receipt, branchId, shiftId: shift.id, cashierId: oldId, paymentMethod: 'cash', subtotal: 180, vatAmount: 0, totalAmount: 180 },
      });
      expect(await deleteAccount(oldId)).toEqual({ deleted: true, outcome: 'deleted' });
    }, 60_000);

    it('the old account, its credentials and sessions are gone and the email is free', async () => {
      expect(await prisma.user.findUnique({ where: { id: oldId } })).toBeNull();
      expect(await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: oldId } })).toBe(0);
      expect(await prisma.pinCredential.count({ where: { userId: oldId } })).toBe(0);
      if (!('access_token' in oldSession)) throw new Error('unexpected 2FA');
      expect(await codeOf(verifyAccessToken(oldSession.access_token))).toBe('TOKEN_REVOKED');
    });

    it('a new account with the same email in different letter case gets a new id and starts fresh', async () => {
      const fresh = await createSupervisor(email.toUpperCase(), 'Successor');
      expect(fresh.id).not.toBe(oldId);
      expect(fresh.email).toBe(email); // stored normalized
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: fresh.id },
        include: { branchAssignments: true, pinCredentials: true, refreshTokens: true },
      });
      expect(row.branchAssignments.map((a) => a.branchId)).toEqual([branchId]); // only what this create granted
      expect(row.pinCredentials).toHaveLength(0);
      expect(row.refreshTokens).toHaveLength(0);
      expect(row.mustChangePassword).toBe(true); // fresh credentials, not the old ones
      expect(await prisma.shift.count({ where: { cashierId: fresh.id } })).toBe(0);
      expect(await prisma.attendanceRecord.count({ where: { employeeId: fresh.id } })).toBe(0);
      expect(await prisma.transaction.count({ where: { cashierId: fresh.id } })).toBe(0);
      // The old PIN does not open the new account on the old device.
      expect(await codeOf(authService.validatePin(fresh.id, oldDevice, '135790'))).toBeDefined();
      if (!('access_token' in oldSession)) throw new Error('unexpected 2FA');
      expect(await codeOf(verifyAccessToken(oldSession.access_token))).toBe('TOKEN_REVOKED');
      expect(await codeOf(authService.refreshToken(oldSession.refreshToken, oldDevice))).toBeDefined();
    });

    it('reports keep attributing the old sale to the original person, not the new account', async () => {
      const rows = await reportsRepository.getDailySalesTransactions({ branchId, page: 1, limit: 50, anyStatus: true } as never);
      const sale = rows.find((r) => r.receipt_number === receipt);
      expect(sale).toBeDefined();
      const text = JSON.stringify(sale);
      expect(text).toContain('Original');
      expect(text).not.toContain('Successor');
      const stored = await prisma.transaction.findFirstOrThrow({ where: { transactionNumber: receipt }, include: { cashier: true } });
      expect(stored.cashierId).toBe(oldId);
      expect(stored.cashier.firstName).toBe('Original');
      expect((await prisma.person.findUniqueOrThrow({ where: { id: oldId } })).accountDeletedAt).not.toBeNull();
    });

    it('a working account keeps its email: the same email in any case is refused', async () => {
      expect(await codeOf(createSupervisor(email, 'Third'))).toBe('EMAIL_ALREADY_EXISTS');
      expect(await codeOf(createSupervisor(`  ${email.toUpperCase()} `, 'Third'))).toBe('EMAIL_ALREADY_EXISTS');
      expect(await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })).toBe(1);
    });
  });

  it('deactivation does not release the email', { timeout: 60_000 }, async () => {
    const email = emailFor('inactive');
    const account = await createSupervisor(email, 'Inactive');
    await employeesService.setEmployeeStatus(account.id, 'inactive', 'left', admin, null);
    expect(await codeOf(createSupervisor(email.toUpperCase(), 'Other'))).toBe('EMAIL_ALREADY_EXISTS');
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('two simultaneous creates with one email (different case) give one account and a clear conflict, not a 500', { timeout: 60_000 }, async () => {
    const email = emailFor('race');
    const settled = await Promise.allSettled([createSupervisor(email, 'RaceOne'), createSupervisor(email.toUpperCase(), 'RaceTwo')]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'EMAIL_ALREADY_EXISTS', statusCode: 409 });
    expect(await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })).toBe(1);
  });

  it('a create racing a delete never leaves two holders; once the delete commits, a retry gets a new account', { timeout: 60_000 }, async () => {
    const email = emailFor('deleteRace');
    const oldId = (await createSupervisor(email, 'Racer')).id;
    const eligibility = await employeesService.getDeletionEligibility(oldId, admin);
    if (!eligibility.confirmation) throw new Error('not deletable');
    const [deleted, created] = await Promise.allSettled([
      employeesService.deleteEmployee(oldId, admin, null, { confirm_name: eligibility.confirmation.name, version: eligibility.confirmation.version }),
      createSupervisor(email, 'Racer2'),
    ]);
    expect(deleted.status).toBe('fulfilled');
    if (created.status === 'rejected') expect(created.reason).toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
    expect(await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })).toBeLessThanOrEqual(1);

    const holder =
      created.status === 'fulfilled' ? created.value : await createSupervisor(email, 'Racer2');
    expect(holder.id).not.toBe(oldId);
    // Repeating the delete or the create changes nothing.
    expect(await employeesService.deleteEmployee(oldId, admin, null, { confirm_name: 'x', version: new Date().toISOString() })).toEqual({
      deleted: true,
      outcome: 'already_deleted',
    });
    expect(await codeOf(createSupervisor(email, 'Racer3'))).toBe('EMAIL_ALREADY_EXISTS');
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });
});
