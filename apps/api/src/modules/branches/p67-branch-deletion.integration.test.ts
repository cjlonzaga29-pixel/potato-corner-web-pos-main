import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P67 — permanent branch deletion keeps business history, against
 * real Postgres (local disposable database only):
 * - the operational branch row, its login account, everyone's access to it
 *   and its configuration are gone;
 * - every sale, shift, attendance record, expense, payroll setting, stock
 *   movement, discount type, fraud alert and audit entry stays, still named
 *   by the branch's original name and code through branch_records;
 * - history never blocks; open work and non-zero stock do, with nothing changed;
 * - the confirmation (typed name + code, version, actor-bound token) is
 *   checked server-side; repeats, races and lost responses are truthful;
 * - writes for a deleted branch are refused by the database;
 * - a same-name replacement gets a new identity, no access, no history,
 *   and the old code is retired.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { branchesService } = await import('./branches.service.js');
const { authService } = await import('../auth/auth.service.js');
const { verifyAccessToken } = await import('../../lib/verify-access-token.js');
const { getAccessibleBranchIds } = await import('../../lib/branch-access.js');
const { isDeletedBranchWrite } = await import('../../lib/foreign-key-restriction.js');
const { receiptsRepository } = await import('../receipts/receipts.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const PASSWORD = 'P67-Br4nch!pass';
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

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe.skipIf(!isLocalDatabase)('POS-PERF-P67 permanent branch deletion keeping history (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  let adminId: string;
  let otherAdminId: string;
  let unitId: string;
  let itemId: string;
  let passwordHash: string;
  const actor = () => ({ id: adminId, role: 'super_admin' });

  async function makeUser(role: 'staff' | 'supervisor' | 'super_admin' | 'branch', label: string) {
    return prisma.user.create({
      data: {
        role,
        firstName: `P67${label}`,
        lastName: suffix,
        employmentType: 'regular',
        email: role === 'staff' ? null : `p67-${label}-${suffix}@test.local`.toLowerCase(),
        passwordHash: role === 'staff' ? null : passwordHash,
        mustChangePassword: false,
      },
    });
  }

  async function makeBranch(label: string, code = `P67${label}-${suffix}`) {
    return prisma.branch.create({ data: { name: `P67 Branch ${label} ${suffix}`, code, address: '1 History St', city: 'Testville', status: 'active' } });
  }

  async function confirmationFor(branchId: string, who = actor()) {
    const eligibility = await branchesService.getDeletionEligibility(branchId, who);
    if (!eligibility.confirmation) throw new Error(`no confirmation offered (${eligibility.blocked_reason ?? 'none'})`);
    return {
      confirm_name: eligibility.confirmation.name,
      confirm_code: eligibility.confirmation.code,
      version: eligibility.confirmation.version,
      confirmation_token: eligibility.confirmation.confirmation_token,
    };
  }

  /** A branch with closed, settled history across every retargeted table, plus a branch account and a staff member. */
  async function branchWithHistory(label: string) {
    const branch = await makeBranch(label);
    const staff = await makeUser('staff', `${label}staff`);
    const account = await makeUser('branch', `${label}acct`);
    await prisma.userBranchAssignment.createMany({ data: [{ userId: staff.id, branchId: branch.id }, { userId: account.id, branchId: branch.id }] });
    const shift = await prisma.shift.create({
      data: {
        branchId: branch.id,
        cashierId: staff.id,
        openedBy: staff.id,
        closedBy: staff.id,
        status: 'closed',
        openingCashAmount: 500,
        closingCashAmount: 750,
        startedAt: new Date(Date.now() - 6 * HOUR),
        closedAt: new Date(Date.now() - 2 * HOUR),
      },
    });
    const sale = await prisma.transaction.create({
      data: {
        transactionNumber: `P67-${label}-${suffix}`,
        branchId: branch.id,
        shiftId: shift.id,
        cashierId: staff.id,
        status: 'completed',
        paymentMethod: 'cash',
        subtotal: 250,
        vatAmount: 0,
        totalAmount: 250,
      },
    });
    await prisma.attendanceRecord.create({
      data: {
        employeeId: staff.id,
        branchId: branch.id,
        clockInServerTime: new Date(Date.now() - 5 * HOUR),
        clockOutServerTime: new Date(Date.now() - 3 * HOUR),
        clockInGpsStatus: 'within_radius',
      },
    });
    await prisma.expense.create({ data: { branchId: branch.id, category: 'supplies', amount: 123.45, incurredAt: new Date(), createdBy: adminId } });
    await prisma.manualDiscountType.create({ data: { branchId: branch.id, name: `P67 type ${suffix}`, createdById: adminId } });
    await prisma.employeePayRate.create({
      data: { employeeId: staff.id, branchId: branch.id, effectiveFrom: new Date('2026-01-01'), hourlyRate: 80, reason: 'P67 fixture', createdBy: adminId, createdByName: 'P67 admin' },
    });
    await prisma.inventoryStock.create({ data: { branchId: branch.id, inventoryItemId: itemId, quantityOnHand: 0 } });
    await prisma.inventoryStockMovement.create({
      data: { branchId: branch.id, inventoryItemId: itemId, movementType: 'RECEIVING', quantityChange: 5, quantityBefore: 0, quantityAfter: 5 },
    });
    await prisma.inventoryStockMovement.create({
      data: { branchId: branch.id, inventoryItemId: itemId, movementType: 'WASTE', quantityChange: -5, quantityBefore: 5, quantityAfter: 0 },
    });
    const ingredient = await prisma.ingredient.create({
      data: { branchId: branch.id, name: `P67-legacy-${label}-${suffix}`, unit: 'g', currentStock: 0, lowStockThreshold: 1, criticalThreshold: 0 },
    });
    await prisma.inventoryMovement.create({
      data: { branchId: branch.id, ingredientId: ingredient.id, movementType: 'stock_in', quantityChange: 10, quantityBefore: 0, quantityAfter: 10 },
    });
    await prisma.fraudAlert.create({ data: { alertType: 'p67_test', severity: 'low', evidence: {}, branchId: branch.id, employeeId: staff.id } });
    await recordAuditLog({ action: 'P67_TEST_ACTION', entityType: 'test', entityId: branch.id, actorId: adminId, actorRole: 'super_admin', branchId: branch.id });
    return { branch, staff, account, shift, sale };
  }

  async function historyCounts(branchId: string) {
    const where = { branchId };
    return {
      sales: await prisma.transaction.count({ where }),
      shifts: await prisma.shift.count({ where }),
      attendance: await prisma.attendanceRecord.count({ where }),
      expenses: await prisma.expense.count({ where }),
      discountTypes: await prisma.manualDiscountType.count({ where }),
      payRates: await prisma.employeePayRate.count({ where }),
      stockMovements: await prisma.inventoryStockMovement.count({ where }),
      legacyMovements: await prisma.inventoryMovement.count({ where }),
      ingredients: await prisma.ingredient.count({ where }),
      fraudAlerts: await prisma.fraudAlert.count({ where }),
      audit: await prisma.auditLog.count({ where: { branchId, action: 'P67_TEST_ACTION' } }),
    };
  }

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 12);
    adminId = (await makeUser('super_admin', 'admin')).id;
    otherAdminId = (await makeUser('super_admin', 'admin2')).id;
    const unit = await prisma.unitOfMeasure.create({ data: { code: `p67-g-${suffix}`, name: 'P67 Gram', dimension: 'WEIGHT', isBaseUnit: true } });
    unitId = unit.id;
    itemId = (await prisma.inventoryItem.create({ data: { name: `P67 potato ${suffix}`, baseUnitId: unitId } })).id;
  });

  // No afterAll: the database is disposable, sales are immutable and branch
  // records are permanent by design.

  describe('deleting a branch with history', () => {
    let fixture: Awaited<ReturnType<typeof branchWithHistory>>;
    let before: Awaited<ReturnType<typeof historyCounts>>;
    let accountToken: string;

    beforeAll(async () => {
      fixture = await branchWithHistory('main');
      before = await historyCounts(fixture.branch.id);
      const login = await authService.login(fixture.account.email as string, PASSWORD, `p67-device-${suffix}`, null);
      if (!('access_token' in login)) throw new Error('unexpected 2FA challenge');
      accountToken = login.access_token;
    });

    it('eligibility: history never blocks; it lists what stays and what goes', async () => {
      const eligibility = await branchesService.getDeletionEligibility(fixture.branch.id, actor());
      expect(eligibility).toMatchObject({ can_delete: true, blocked_reason: null, blockers: [] });
      expect(eligibility.history_retained).toMatchObject({ sales: 1, shifts: 1, attendance: 1, expenses: 1, stock_movements: 2 });
      expect(eligibility.removed).toMatchObject({ branch_accounts: 1, staff_and_supervisor_access: 1, zero_stock_rows: 1 });
      expect(eligibility.confirmation).toMatchObject({ name: fixture.branch.name, code: fixture.branch.code });
    });

    it('cancel (no request), wrong name/code, another admin’s token and a stale version change nothing', async () => {
      const body = await confirmationFor(fixture.branch.id);
      expect(await codeOf(branchesService.deleteBranch(fixture.branch.id, actor(), null, { ...body, confirm_name: 'P67 Branch' }))).toBe(
        'DELETE_CONFIRMATION_MISMATCH',
      );
      expect(await codeOf(branchesService.deleteBranch(fixture.branch.id, actor(), null, { ...body, confirm_code: 'WRONG' }))).toBe(
        'DELETE_CONFIRMATION_MISMATCH',
      );
      const otherBody = await confirmationFor(fixture.branch.id, { id: otherAdminId, role: 'super_admin' });
      expect(await codeOf(branchesService.deleteBranch(fixture.branch.id, actor(), null, otherBody))).toBe('DELETE_CONFIRMATION_INVALID');
      await prisma.branch.update({ where: { id: fixture.branch.id }, data: { address: '2 History St' } });
      expect(await codeOf(branchesService.deleteBranch(fixture.branch.id, actor(), null, body))).toBe('BRANCH_CHANGED');
      expect(await prisma.branch.findUnique({ where: { id: fixture.branch.id } })).not.toBeNull();
      expect(await historyCounts(fixture.branch.id)).toEqual(before);
      await expect(verifyAccessToken(accountToken)).resolves.toMatchObject({ user_id: fixture.account.id });
    });

    it('deletes the operational branch, its account, access and configuration', async () => {
      const result = await branchesService.deleteBranch(fixture.branch.id, actor(), '127.0.0.1', await confirmationFor(fixture.branch.id));
      expect(result).toEqual({ deleted: true, outcome: 'deleted' });
      expect(await prisma.branch.findUnique({ where: { id: fixture.branch.id } })).toBeNull();
      expect(await prisma.userBranchAssignment.count({ where: { branchId: fixture.branch.id } })).toBe(0);
      expect(await prisma.inventoryStock.count({ where: { branchId: fixture.branch.id } })).toBe(0);
      expect(await prisma.user.findUnique({ where: { id: fixture.account.id } })).toBeNull();
      // The staff member is a person, not the branch: they keep their account, without this branch.
      expect(await prisma.user.findUnique({ where: { id: fixture.staff.id } })).not.toBeNull();
      const record = await prisma.branchRecord.findUniqueOrThrow({ where: { id: fixture.branch.id } });
      expect(record).toMatchObject({ name: fixture.branch.name, code: fixture.branch.code, address: '2 History St', deletedBy: adminId });
      expect(record.deletedAt).not.toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BRANCH_DELETED', entityId: fixture.branch.id } });
      expect(audit.branchId).toBe(fixture.branch.id);
    });

    it('keeps every history row, its amounts and its branch name and code', async () => {
      expect(await historyCounts(fixture.branch.id)).toEqual(before);
      const receipt = await receiptsRepository.findByTransactionNumber(fixture.sale.transactionNumber);
      expect(receipt).not.toBeNull();
      expect(Number(receipt?.totalAmount)).toBe(250);
      const sale = await prisma.transaction.findUniqueOrThrow({ where: { id: fixture.sale.id }, include: { branch: true, cashier: true } });
      expect(sale.branch).toMatchObject({ name: fixture.branch.name, code: fixture.branch.code });
      expect(sale.cashier.firstName).toBe('P67mainstaff');
      const shift = await prisma.shift.findUniqueOrThrow({ where: { id: fixture.shift.id }, include: { branch: { select: { name: true } } } });
      expect(Number(shift.closingCashAmount)).toBe(750);
      expect(shift.branch.name).toBe(fixture.branch.name);
      const expense = await prisma.expense.findFirstOrThrow({ where: { branchId: fixture.branch.id }, include: { branch: { select: { code: true } } } });
      expect(Number(expense.amount)).toBe(123.45);
      expect(expense.branch.code).toBe(fixture.branch.code);
      // The deleted branch account's history attribution stays on people.
      expect(await prisma.person.findUnique({ where: { id: fixture.account.id } })).toMatchObject({ firstName: 'P67mainacct' });
    });

    it('ends access: the branch account token is refused and staff tokens lose the branch', async () => {
      expect(await codeOf(verifyAccessToken(accountToken))).toBe('TOKEN_REVOKED');
      expect(await codeOf(authService.login(fixture.account.email as string, PASSWORD, `p67-device-${suffix}`, null))).toBeDefined();
      const staffToken = { user_id: fixture.staff.id, role: 'staff', email: null, branch_ids: [fixture.branch.id] } as unknown as JwtPayload;
      expect(await getAccessibleBranchIds(staffToken)).toEqual([]);
    });

    it('refuses new operational writes for the deleted branch in the database', async () => {
      const error = await errorOf(
        prisma.shift.create({
          data: { branchId: fixture.branch.id, cashierId: fixture.staff.id, openedBy: fixture.staff.id, status: 'active', openingCashAmount: 0, startedAt: new Date() },
        }),
      );
      expect(isDeletedBranchWrite(error)).toBe(true);
      expect(isDeletedBranchWrite(await errorOf(prisma.expense.create({ data: { branchId: fixture.branch.id, category: 'supplies', amount: 1, incurredAt: new Date(), createdBy: adminId } }))))
        .toBe(true);
      // Evidence about the branch may still be recorded.
      await recordAuditLog({ action: 'P67_AFTER_DELETE', entityType: 'test', entityId: fixture.branch.id, actorId: adminId, actorRole: 'super_admin', branchId: fixture.branch.id });
      expect(await prisma.auditLog.count({ where: { action: 'P67_AFTER_DELETE', branchId: fixture.branch.id } })).toBe(1);
    });

    it('the branch record is frozen and never removed', async () => {
      expect(await errorOf(prisma.branchRecord.update({ where: { id: fixture.branch.id }, data: { name: 'Renamed' } }))).toBeDefined();
      expect(await errorOf(prisma.branchRecord.delete({ where: { id: fixture.branch.id } }))).toBeDefined();
      expect((await prisma.branchRecord.findUniqueOrThrow({ where: { id: fixture.branch.id } })).name).toBe(fixture.branch.name);
    });

    it('a repeat after a lost response reports already_deleted; eligibility says so too', async () => {
      const body = { confirm_name: fixture.branch.name, confirm_code: fixture.branch.code, version: new Date().toISOString(), confirmation_token: 'a'.repeat(64) };
      await expect(branchesService.deleteBranch(fixture.branch.id, actor(), null, body)).resolves.toEqual({ deleted: true, outcome: 'already_deleted' });
      await expect(branchesService.getDeletionEligibility(fixture.branch.id, actor())).resolves.toMatchObject({ blocked_reason: 'already_deleted' });
      expect(await codeOf(branchesService.deleteBranch(randomUUID(), actor(), null, body))).toBe('BRANCH_NOT_FOUND');
    });

    it('a same-name replacement gets a new identity, no access and no history; the old code is retired', async () => {
      expect(
        await codeOf(branchesService.createBranch({ name: fixture.branch.name, code: fixture.branch.code, address: 'x', city: 'Testville', gpsRadiusMeters: 100, status: 'active' }, actor(), null)),
      ).toBe('BRANCH_CODE_RETIRED');
      expect(await errorOf(prisma.branch.create({ data: { name: 'x', code: fixture.branch.code, address: 'x', city: 'x' } }))).toBeDefined();
      expect(await errorOf(prisma.branch.create({ data: { id: fixture.branch.id, name: 'x', code: `P67reuse-${suffix}`, address: 'x', city: 'x' } }))).toBeDefined();
      const replacement = await makeBranch('main-again', `P67NEW-${suffix}`);
      await prisma.branch.update({ where: { id: replacement.id }, data: { name: fixture.branch.name } });
      expect(replacement.id).not.toBe(fixture.branch.id);
      expect(await prisma.userBranchAssignment.count({ where: { branchId: replacement.id } })).toBe(0);
      expect(await historyCounts(replacement.id)).toEqual({
        sales: 0, shifts: 0, attendance: 0, expenses: 0, discountTypes: 0, payRates: 0, stockMovements: 0, legacyMovements: 0, ingredients: 0, fraudAlerts: 0, audit: 0,
      });
      const staffToken = { user_id: fixture.staff.id, role: 'staff', email: null, branch_ids: [fixture.branch.id] } as unknown as JwtPayload;
      expect(await getAccessibleBranchIds(staffToken)).toEqual([]);
      // Both records keep their own identity even with the same name.
      expect(await prisma.branchRecord.count({ where: { name: fixture.branch.name } })).toBe(2);
    });
  });

  describe('open work blocks, and nothing changes', () => {
    it('an open shift, an open clock-in and non-zero stock block with instructions', async () => {
      const { branch, staff } = await branchWithHistory('blocked');
      await prisma.shift.create({ data: { branchId: branch.id, cashierId: staff.id, openedBy: staff.id, status: 'active', openingCashAmount: 0, startedAt: new Date() } });
      await prisma.attendanceRecord.create({ data: { employeeId: staff.id, branchId: branch.id, clockInServerTime: new Date(), clockInGpsStatus: 'within_radius' } });
      await prisma.inventoryStock.update({ where: { branchId_inventoryItemId: { branchId: branch.id, inventoryItemId: itemId } }, data: { quantityOnHand: 3 } });
      const eligibility = await branchesService.getDeletionEligibility(branch.id, actor());
      expect(eligibility.can_delete).toBe(false);
      expect(eligibility.blockers.map((b) => b.code).sort()).toEqual(['nonzero_stock', 'open_attendance', 'open_shifts']);
      const error = (await errorOf(branchesService.deleteBranch(branch.id, actor(), null, await confirmationFor(branch.id)))) as { code: string; details: unknown };
      expect(error.code).toBe('BRANCH_HAS_OPEN_OPERATIONS');
      expect(await prisma.branch.findUnique({ where: { id: branch.id } })).not.toBeNull();
      expect(Number((await prisma.inventoryStock.findFirstOrThrow({ where: { branchId: branch.id } })).quantityOnHand)).toBe(3);
      expect((await prisma.branchRecord.findUniqueOrThrow({ where: { id: branch.id } })).deletedAt).toBeNull();
    });

    it('draft payroll and unpaid hours block', async () => {
      const { branch, staff } = await branchWithHistory('payroll');
      await prisma.payrollPolicy.create({
        data: { branchId: branch.id, timezone: 'Asia/Manila', periodType: 'semi_monthly', breakTreatment: 'unpaid', createdBy: adminId, createdByName: 'P67 admin', version: 1, createdAt: new Date(Date.now() - 48 * HOUR) },
      });
      void staff;
      const eligibility = await branchesService.getDeletionEligibility(branch.id, actor());
      expect(eligibility.blockers.map((b) => b.code)).toContain('unpaid_payroll_hours');
    });
  });

  describe('races', () => {
    it('two simultaneous deletes give exactly one deleted and one already_deleted', async () => {
      const { branch } = await branchWithHistory('race');
      const body = await confirmationFor(branch.id);
      const results = await Promise.allSettled([
        branchesService.deleteBranch(branch.id, actor(), null, body),
        branchesService.deleteBranch(branch.id, actor(), null, body),
      ]);
      const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value.outcome : (r.reason as ErrorWithCode).code)).sort();
      expect(outcomes).toEqual(['already_deleted', 'deleted']);
    });

    it('a shift opened while the delete runs either blocks the delete or is refused; never both committed', async () => {
      const { branch, staff } = await branchWithHistory('raceshift');
      const body = await confirmationFor(branch.id);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let inserted!: () => void;
      const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
      const shiftTx = prisma.$transaction(
        async (tx) => {
          await tx.shift.create({ data: { branchId: branch.id, cashierId: staff.id, openedBy: staff.id, status: 'active', openingCashAmount: 0, startedAt: new Date() } });
          inserted();
          await gate;
        },
        { timeout: 30_000 },
      );
      await insertedSignal;
      const deletion = branchesService.deleteBranch(branch.id, actor(), null, body).then(
        (r) => r.outcome,
        (e: ErrorWithCode) => e.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await shiftTx;
      const outcome = await deletion;
      const branchExists = (await prisma.branch.findUnique({ where: { id: branch.id } })) !== null;
      const openShifts = await prisma.shift.count({ where: { branchId: branch.id, status: 'active' } });
      expect(['BRANCH_HAS_OPEN_OPERATIONS', 'BRANCH_ACTIVITY_DURING_DELETE']).toContain(outcome);
      expect(branchExists).toBe(true);
      expect(openShifts).toBe(1);
    });

    it('a write after the delete has taken the branch lock waits and is then refused', async () => {
      const { branch, staff } = await branchWithHistory('racewrite');
      const body = await confirmationFor(branch.id);
      const deletion = branchesService.deleteBranch(branch.id, actor(), null, body);
      const write = errorOf(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return prisma.expense.create({ data: { branchId: branch.id, category: 'supplies', amount: 9, incurredAt: new Date(), createdBy: staff.id } });
        })(),
      );
      const [outcome, writeError] = await Promise.all([deletion.then((r) => r.outcome, (e: ErrorWithCode) => e.code), write]);
      const expenses = await prisma.expense.count({ where: { branchId: branch.id, amount: 9 } });
      if (outcome === 'deleted') {
        // Either the write committed first (then the fingerprint would have aborted the delete) or it was refused.
        expect(isDeletedBranchWrite(writeError)).toBe(true);
        expect(expenses).toBe(0);
      } else {
        expect(outcome).toBe('BRANCH_ACTIVITY_DURING_DELETE');
        expect(expenses).toBe(1);
        expect(await prisma.branch.findUnique({ where: { id: branch.id } })).not.toBeNull();
      }
    });
  });
});
