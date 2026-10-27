import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P40 — against real Postgres:
 * - Admin attendance: supervisor scope = CURRENT branch assignments,
 *   overlapping supervisors never duplicate a record, an overnight shift
 *   started yesterday is visible in the open-now view (and not in a
 *   "today" range), and counts_toward_clocked_in matches the dashboard's
 *   Staff Clocked In rule exactly.
 * - Work Hours: a branch override affects only that branch, clearing it
 *   falls back to the global value, and no stored attendance record is
 *   rewritten by either.
 * - Transaction PDF: the export selects every row matching the filters
 *   (not a page), honours receipt search, status and accessible-branch
 *   limits, refuses nothing it shouldn't, and returns a real PDF.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { attendanceService } = await import('./attendance.service.js');
const { settingsService } = await import('../settings/settings.service.js');
const { branchesService } = await import('../branches/branches.service.js');
const { transactionsService } = await import('../transactions/transactions.service.js');
const { transactionsRepository } = await import('../transactions/transactions.repository.js');

const HOUR = 60 * 60 * 1000;

describe.skipIf(!isLocalDatabase)('POS-PERF-P40 admin management (real Postgres)', () => {
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const branchIds: string[] = [];
  const settingKeys: string[] = [];
  let branchA: string;
  let branchB: string;
  let supervisorBoth: string;
  let supervisorB: string;
  let admin: JwtPayload;
  const records: Record<string, string> = {};

  async function makeUser(role: 'staff' | 'supervisor' | 'super_admin', label: string, extra: { isActive?: boolean } = {}) {
    const user = await prisma.user.create({
      data: {
        role,
        firstName: `P40${label}`,
        lastName: suffix,
        employmentType: 'regular',
        email: role === 'staff' ? null : `p40-${label}-${suffix}@test.local`,
        isActive: extra.isActive ?? true,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function assign(userId: string, branchId: string) {
    await prisma.userBranchAssignment.create({ data: { userId, branchId, assignedAt: new Date() } });
  }

  async function attendance(label: string, employeeId: string, branchId: string, clockIn: Date, clockOut: Date | null, overtimeMinutes = 0) {
    const record = await prisma.attendanceRecord.create({
      data: {
        employeeId,
        branchId,
        clockInServerTime: clockIn,
        clockInGpsStatus: 'within_radius',
        clockOutServerTime: clockOut,
        actualWorkMinutes: clockOut ? Math.round((clockOut.getTime() - clockIn.getTime()) / 60000) : null,
        overtimeMinutes,
      },
    });
    records[label] = record.id;
    return record.id;
  }

  beforeAll(async () => {
    for (const label of ['A', 'B']) {
      const branch = await prisma.branch.create({
        data: { name: `P40 Branch ${label} ${suffix}`, code: `P40${label}-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
      });
      branchIds.push(branch.id);
    }
    [branchA, branchB] = branchIds as [string, string];

    const adminId = await makeUser('super_admin', 'admin');
    admin = { user_id: adminId, role: 'super_admin', email: `p40-admin-${suffix}@test.local` } as JwtPayload;

    supervisorBoth = await makeUser('supervisor', 'supBoth');
    supervisorB = await makeUser('supervisor', 'supB');
    await assign(supervisorBoth, branchA);
    await assign(supervisorBoth, branchB);
    await assign(supervisorB, branchB);

    const staffA = await makeUser('staff', 'staffA');
    const staffB = await makeUser('staff', 'staffB');
    const staffInactive = await makeUser('staff', 'staffInactive', { isActive: false });
    await assign(staffA, branchA);
    await assign(staffB, branchB);
    await assign(staffInactive, branchB);

    const now = Date.now();
    // Overnight: started ~20h ago (an earlier Manila day in most runs), still open.
    await attendance('overnightOpenA', staffA, branchA, new Date(now - 20 * HOUR), null);
    await attendance('closedTodayB', staffB, branchB, new Date(now - 3 * HOUR), new Date(now - 1 * HOUR), 30);
    await attendance('openInactiveB', staffInactive, branchB, new Date(now - 2 * HOUR), null);
  });

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { branchId: { in: branchIds } } });
    // Transactions are immutable through the Prisma client (CR-004); test teardown removes them directly, like other integration suites.
    for (const branchId of branchIds) await prisma.$executeRaw`DELETE FROM "transactions" WHERE "branch_id" = ${branchId}`;
    await prisma.systemSetting.deleteMany({ where: { key: { in: settingKeys } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
  });

  const listAll = { page: 1, limit: 100 };

  describe('admin attendance', () => {
    it('scopes a supervisor filter to that supervisor’s current branches, once per record despite overlapping assignments', async () => {
      const both = await attendanceService.getForAdmin({ ...listAll, supervisorId: supervisorBoth, openOnly: true }, admin);
      const ids = both.records.map((r) => r.id).sort();
      expect(ids).toEqual([records.overnightOpenA, records.openInactiveB].sort());
      expect(new Set(ids).size).toBe(ids.length);
      expect(both.scope.supervisor?.branch_ids.sort()).toEqual([branchA, branchB].sort());

      const onlyB = await attendanceService.getForAdmin({ ...listAll, supervisorId: supervisorB, openOnly: true }, admin);
      expect(onlyB.records.map((r) => r.id)).toEqual([records.openInactiveB]);
    });

    it('returns an empty, explained scope when a branch filter is outside the supervisor’s branches', async () => {
      const result = await attendanceService.getForAdmin({ ...listAll, supervisorId: supervisorB, branchId: branchA }, admin);
      expect(result.total).toBe(0);
      expect(result.scope.branch_ids).toEqual([]);
    });

    it('shows overnight open shifts in the open-now view and flags exactly what the dashboard counts', async () => {
      const result = await attendanceService.getForAdmin({ ...listAll, openOnly: true }, admin);
      const byId = new Map(result.records.map((r) => [r.id, r]));
      expect(byId.get(records.overnightOpenA as string)?.counts_toward_clocked_in).toBe(true);
      expect(byId.get(records.openInactiveB as string)?.counts_toward_clocked_in).toBe(false);
      expect(byId.has(records.closedTodayB as string)).toBe(false);

      // Cross-check against the dashboard's own per-branch figure.
      const stats = await branchesService.getAllBranchStats(admin);
      const dashboard = stats.filter((s) => branchIds.includes(s.branchId)).reduce((sum, s) => sum + s.staffTimedInCount, 0);
      const counted = result.records.filter((r) => branchIds.includes(r.branch_id) && r.counts_toward_clocked_in === true).length;
      expect(counted).toBe(dashboard);
    });

    it('rejects non-admin callers and unknown supervisors', async () => {
      await expect(
        attendanceService.getForAdmin(listAll, { user_id: supervisorB, role: 'supervisor', email: 'x', branch_ids: [branchB] } as JwtPayload),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(attendanceService.getForAdmin({ ...listAll, supervisorId: randomUUID() }, admin)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('work hours', () => {
    it('isolates a branch override, falls back to the global value, and never rewrites stored attendance', async () => {
      settingKeys.push(`work_hours_policy:branch:${branchA}`);
      const global = await settingsService.getWorkHoursPolicy();
      const before = await prisma.attendanceRecord.findMany({ where: { branchId: { in: branchIds } }, orderBy: { id: 'asc' } });

      await settingsService.setBranchWorkHours(branchA, { regularHours: 9.5 }, admin, null);
      expect(await settingsService.getRegularShiftMinutes(branchA)).toBe(570);
      expect(await settingsService.getRegularShiftMinutes(branchB)).toBe(Math.round(global.regularHours * 60));
      expect(await settingsService.getRegularShiftMinutes()).toBe(Math.round(global.regularHours * 60));
      expect((await settingsService.getBranchWorkHours(branchA)).source).toBe('branch');
      expect((await settingsService.getBranchWorkHours(branchB)).source).toBe('global');

      const listed = await settingsService.listBranchWorkHours();
      expect(listed.branches.find((b) => b.branchId === branchA)?.regularHours).toBe(9.5);
      expect(listed.branches.find((b) => b.branchId === branchB)?.source).toBe('global');

      await settingsService.clearBranchWorkHours(branchA, admin, null);
      expect(await settingsService.getRegularShiftMinutes(branchA)).toBe(Math.round(global.regularHours * 60));
      // Clearing twice is a harmless no-op.
      await settingsService.clearBranchWorkHours(branchA, admin, null);

      const after = await prisma.attendanceRecord.findMany({ where: { branchId: { in: branchIds } }, orderBy: { id: 'asc' } });
      expect(after.map((r) => [r.id, r.overtimeMinutes, r.actualWorkMinutes, r.updatedAt.toISOString()])).toEqual(
        before.map((r) => [r.id, r.overtimeMinutes, r.actualWorkMinutes, r.updatedAt.toISOString()]),
      );
    });
  });

  describe('transaction PDF export', () => {
    let cashier: string;

    beforeAll(async () => {
      cashier = userIds.find((id) => id) as string;
      const make = (n: number, branchId: string, status: 'completed' | 'voided', extra: Record<string, unknown> = {}) =>
        prisma.transaction.create({
          data: {
            transactionNumber: `PC-P40-${suffix}-${String(n).padStart(4, '0')}`,
            branchId,
            cashierId: cashier,
            paymentMethod: 'gcash',
            gcashReference: `REF${n}`,
            subtotal: 100,
            vatAmount: 10.71,
            totalAmount: 100,
            status,
            createdAt: new Date(Date.now() - n * 60_000),
            ...extra,
          },
        });
      // 30 rows at A (more than one 25-row page), 2 at B.
      for (let n = 1; n <= 30; n += 1) await make(n, branchA, n % 10 === 0 ? 'voided' : 'completed');
      await make(31, branchB, 'completed', {
        discountType: 'pwd',
        discountAmount: 17.86,
        totalAmount: 71.43,
        vatAmount: 0,
        // Not a valid ciphertext: exercises the export's "cannot decrypt" path
        // (prints "Unreadable", never fails the whole PDF). Authorized
        // decryption itself is covered by transactions.export.test.ts.
        discountCustomerIdEncrypted: 'not-a-valid-ciphertext',
      });
      await make(32, branchB, 'completed');
    });

    it('selects every matching row across pages, honouring branch, status and receipt search', async () => {
      expect(await transactionsRepository.countForExport({ branchId: branchA })).toBe(30);
      expect(await transactionsRepository.countForExport({ branchId: branchA, status: 'voided' })).toBe(3);
      expect(await transactionsRepository.countForExport({ branchId: branchA, receiptSearch: `p40-${suffix}-000` })).toBe(9);
      expect(await transactionsRepository.countForExport({ branchIds: [branchB], receiptSearch: suffix })).toBe(2);
      const single = await transactionsRepository.findForExport({ transactionId: (await prisma.transaction.findFirstOrThrow({ where: { branchId: branchB, discountType: 'pwd' } })).id });
      expect(single).toHaveLength(1);
      expect(single[0]?.branch.name).toContain('P40 Branch B');
    });

    it('produces a real PDF named for its scope', async () => {
      const result = await transactionsService.exportTransactionsPdf({ branchId: branchA }, { branchName: `P40 Branch A ${suffix}` }, { id: admin.user_id, role: 'super_admin' }, null);
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.rowCount).toBe(30);
      expect(result.filename).toMatch(/^transactions-filtered-P40-Branch-A-[A-Za-z0-9]+\.pdf$/);

      const pwd = await prisma.transaction.findFirstOrThrow({ where: { branchId: branchB, discountType: 'pwd' } });
      const single = await transactionsService.exportTransactionsPdf({ transactionId: pwd.id }, { branchName: null }, { id: admin.user_id, role: 'super_admin' }, null);
      expect(single.rowCount).toBe(1);
      expect(single.filename).toBe(`transactions-single-PC-P40-${suffix}-0031.pdf`);
      // Nothing was decrypted, so no PII-access audit entry is written.
      const audit = await prisma.auditLog.findFirst({ where: { actorId: admin.user_id, action: 'DISCOUNT_AUDIT_PII_ACCESSED' } });
      expect(audit).toBeNull();
    });
  });
});
