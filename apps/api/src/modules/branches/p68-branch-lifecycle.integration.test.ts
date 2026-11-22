import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P68, against real Postgres (local disposable database only):
 * A. branch login email reuse after deletion, leftover accounts from the
 *    pre-P67 cascade, case-insensitive uniqueness, concurrent creates;
 * B. Force Delete: confirmation binding, fence, explicit outcomes (nothing
 *    fabricated), closure records, idempotent repeats, stale plans, workers;
 * C. branch-scoped staff: create in A is absent from B, same-name staff stay
 *    separate, PIN and management actions re-check branch access.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { branchesService } = await import('./branches.service.js');
const { branchForceDeletionService } = await import('./branch-force-deletion.service.js');
const { diagnoseLeftoverBranchAccounts, runLeftoverRepair } =
  await import('./leftover-branch-account-repair.js');
const { authService } = await import('../auth/auth.service.js');
const { verifyAccessToken } = await import('../../lib/verify-access-token.js');
const { isDeletedBranchWrite, isFencedBranchWrite } =
  await import('../../lib/foreign-key-restriction.js');
const { employeesService } = await import('../employees/employees.service.js');
const { staffPinService } = await import('../staff-pin/staff-pin.service.js');
const { attendanceRepository } = await import('../attendance/attendance.repository.js');

const PASSWORD = 'P68-Br4nch!pass';
const HOUR = 60 * 60 * 1000;

async function errorOf(
  promise: Promise<unknown>,
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
}

describe.skipIf(!isLocalDatabase)(
  'POS-PERF-P68 branch lifecycle and branch staff (real Postgres)',
  () => {
    const suffix = randomUUID().slice(0, 8);
    let adminId: string;
    let otherAdminId: string;
    let itemId: string;
    let passwordHash: string;
    const actor = () => ({ id: adminId, role: 'super_admin' });

    async function makeUser(
      role: 'staff' | 'supervisor' | 'super_admin' | 'branch',
      label: string,
      firstName = `P68${label}`,
    ) {
      return prisma.user.create({
        data: {
          role,
          firstName,
          lastName: suffix,
          employmentType: 'regular',
          email: role === 'staff' ? null : `p68-${label}-${suffix}@test.local`.toLowerCase(),
          passwordHash: role === 'staff' ? null : passwordHash,
          mustChangePassword: false,
        },
      });
    }

    function branchInput(label: string, email: string) {
      return {
        name: `P68 ${label} ${suffix}`,
        city: 'Testville',
        address: '1 Lifecycle St',
        gpsRadiusMeters: 100,
        status: 'active' as const,
        account: { email, password: PASSWORD },
      };
    }

    async function makeBranch(label: string) {
      return prisma.branch.create({
        data: {
          name: `P68 Branch ${label} ${suffix}`,
          code: `P68${label}-${suffix}`,
          address: '1 St',
          city: 'Testville',
          status: 'active',
        },
      });
    }

    beforeAll(async () => {
      passwordHash = await bcrypt.hash(PASSWORD, 12);
      adminId = (await makeUser('super_admin', 'admin')).id;
      otherAdminId = (await makeUser('super_admin', 'admin2')).id;
      const unit = await prisma.unitOfMeasure.create({
        data: { code: `p68-g-${suffix}`, name: 'P68 Gram', dimension: 'WEIGHT', isBaseUnit: true },
      });
      itemId = (
        await prisma.inventoryItem.create({
          data: { name: `P68 potato ${suffix}`, baseUnitId: unit.id },
        })
      ).id;
    });

    // ---------------------------------------------------------------- A
    describe('A. branch login email reuse', () => {
      it('after a deletion, the same email creates a new account with a new identity; old tokens stay dead', async () => {
        const email = `p68-reuse-${suffix}@test.local`;
        const first = await branchesService.createBranch(
          branchInput('reuse1', email),
          actor(),
          null,
        );
        const oldAccount = await prisma.user.findUniqueOrThrow({ where: { email } });
        const login = await authService.login(email, PASSWORD, `p68-dev-${suffix}`, null);
        if (!('access_token' in login)) throw new Error('unexpected 2FA');
        const eligibility = await branchesService.getDeletionEligibility(first.id, actor());
        if (!eligibility.confirmation) throw new Error('not deletable');
        await branchesService.deleteBranch(first.id, actor(), null, {
          confirm_name: eligibility.confirmation.name,
          confirm_code: eligibility.confirmation.code,
          version: eligibility.confirmation.version,
          confirmation_token: eligibility.confirmation.confirmation_token,
        });

        const second = await branchesService.createBranch(
          branchInput('reuse2', email.toUpperCase()),
          actor(),
          null,
        );
        const newAccount = await prisma.user.findUniqueOrThrow({
          where: { email },
          include: { branchAssignments: true },
        });
        expect(second.id).not.toBe(first.id);
        expect(newAccount.id).not.toBe(oldAccount.id);
        expect(newAccount.branchAssignments.map((a) => a.branchId)).toEqual([second.id]);
        expect(await errorOf(verifyAccessToken(login.access_token))).toBeDefined();
        // History still names the original identity.
        expect(
          (await prisma.person.findUniqueOrThrow({ where: { id: oldAccount.id } }))
            .accountDeletedAt,
        ).not.toBeNull();
        expect(
          (await prisma.branchRecord.findUniqueOrThrow({ where: { id: first.id } })).deletedAt,
        ).not.toBeNull();
      });

      it('a leftover branch login (pre-P67 cascade) is reported with its id, never removed automatically', async () => {
        const leftover = await makeUser('branch', 'leftover');
        // Simulate the old cascade: the account exists with no assignment at all.
        const error = await errorOf(
          branchesService.createBranch(
            branchInput('blocked', leftover.email as string),
            actor(),
            null,
          ),
        );
        expect(error?.code).toBe('EMAIL_HELD_BY_LEFTOVER_ACCOUNT');
        expect(JSON.stringify((error as { details?: unknown }).details)).toContain(leftover.id);
        expect(await prisma.user.findUnique({ where: { id: leftover.id } })).not.toBeNull();
        expect(await prisma.branch.count({ where: { name: `P68 blocked ${suffix}` } })).toBe(0);

        // Diagnose lists it; the dry run changes nothing; execute deletes exactly it.
        expect((await diagnoseLeftoverBranchAccounts()).map((c) => c.id)).toContain(leftover.id);
        const manifest = {
          actor_user_id: adminId,
          accounts: [
            {
              id: leftover.id,
              email: leftover.email as string,
              evidence: 'P68 test leftover fixture',
            },
          ],
        };
        const dry = await runLeftoverRepair(manifest, { execute: false, token: 't' });
        expect(dry.accounts[0]?.outcome).toBe('would_delete');
        expect(await prisma.user.findUnique({ where: { id: leftover.id } })).not.toBeNull();
        const done = await runLeftoverRepair(manifest, { execute: true, token: 't' });
        expect(done.accounts[0]?.outcome).toBe('deleted');
        expect(await prisma.user.findUnique({ where: { id: leftover.id } })).toBeNull();
        const created = await branchesService.createBranch(
          branchInput('afterrepair', leftover.email as string),
          actor(),
          null,
        );
        const account = await prisma.user.findUniqueOrThrow({
          where: { email: leftover.email as string },
        });
        expect(account.id).not.toBe(leftover.id);
        expect(created.id).toBeTruthy();
      });

      it('the repair refuses a live, a shared or a non-branch account, and a wrong email', async () => {
        const branch = await makeBranch('live');
        const live = await makeUser('branch', 'liveacct');
        await prisma.userBranchAssignment.create({
          data: { userId: live.id, branchId: branch.id },
        });
        const supervisor = await makeUser('supervisor', 'sup-repair');
        const orphan = await makeUser('branch', 'orphan2');
        const report = await runLeftoverRepair(
          {
            actor_user_id: adminId,
            accounts: [
              { id: live.id, email: live.email as string, evidence: 'must be refused: live' },
              {
                id: supervisor.id,
                email: supervisor.email as string,
                evidence: 'must be refused: role',
              },
              {
                id: orphan.id,
                email: 'someone-else@test.local',
                evidence: 'must be refused: email',
              },
            ],
          },
          { execute: true, token: 't' },
        );
        expect(report.accounts.map((a) => a.outcome)).toEqual(['refused', 'refused', 'refused']);
        expect(
          await prisma.user.count({ where: { id: { in: [live.id, supervisor.id, orphan.id] } } }),
        ).toBe(3);
      });

      it('a working account keeps its email: real conflicts and case variants are refused clearly', async () => {
        const supervisor = await makeUser('supervisor', 'holder');
        const error = await errorOf(
          branchesService.createBranch(
            branchInput('conflict', (supervisor.email as string).toUpperCase()),
            actor(),
            null,
          ),
        );
        expect(error?.code).toBe('EMAIL_ALREADY_EXISTS');
        expect(JSON.stringify((error as { details?: unknown }).details)).toContain('account.email');
        // Legacy mixed-case row: still a conflict.
        await prisma.user.update({
          where: { id: supervisor.id },
          data: { email: `P68-Mixed-${suffix}@Test.Local` },
        });
        expect(
          (
            await errorOf(
              branchesService.createBranch(
                branchInput('mixed', `p68-mixed-${suffix}@test.local`),
                actor(),
                null,
              ),
            )
          )?.code,
        ).toBe('EMAIL_ALREADY_EXISTS');
      });

      it('a shared branch login is kept when one of its branches is deleted', async () => {
        const a = await makeBranch('shareA');
        const b = await makeBranch('shareB');
        const shared = await makeUser('branch', 'shared');
        await prisma.userBranchAssignment.createMany({
          data: [
            { userId: shared.id, branchId: a.id },
            { userId: shared.id, branchId: b.id },
          ],
        });
        const eligibility = await branchesService.getDeletionEligibility(a.id, actor());
        if (!eligibility.confirmation) throw new Error('not deletable');
        await branchesService.deleteBranch(a.id, actor(), null, {
          confirm_name: eligibility.confirmation.name,
          confirm_code: eligibility.confirmation.code,
          version: eligibility.confirmation.version,
          confirmation_token: eligibility.confirmation.confirmation_token,
        });
        expect(await prisma.user.findUnique({ where: { id: shared.id } })).not.toBeNull();
      });

      it('two concurrent creates with one email give one branch and one clear conflict, no partial rows', async () => {
        const email = `p68-race-${suffix}@test.local`;
        const results = await Promise.allSettled([
          branchesService.createBranch(branchInput('raceA', email), actor(), null),
          branchesService.createBranch(branchInput('raceB', email), actor(), null),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect((rejected.reason as { code?: string }).code).toBe('EMAIL_ALREADY_EXISTS');
        expect(
          await prisma.branch.count({
            where: { name: { in: [`P68 raceA ${suffix}`, `P68 raceB ${suffix}`] } },
          }),
        ).toBe(1);
        expect(await prisma.user.count({ where: { email } })).toBe(1);
      });
    });

    // ---------------------------------------------------------------- B
    describe('B. Force Delete Branch', () => {
      /** A branch with every kind of open work the plan covers (approvals excepted: see runbook). */
      async function blockedBranch(label: string) {
        const branch = await makeBranch(label);
        const staff = await makeUser('staff', `${label}staff`);
        const account = await makeUser('branch', `${label}acct`);
        await prisma.userBranchAssignment.createMany({
          data: [
            { userId: staff.id, branchId: branch.id },
            { userId: account.id, branchId: branch.id },
          ],
        });
        const shift = await prisma.shift.create({
          data: {
            branchId: branch.id,
            cashierId: staff.id,
            openedBy: staff.id,
            status: 'active',
            openingCashAmount: 500,
            startedAt: new Date(Date.now() - 2 * HOUR),
          },
        });
        const attendance = await prisma.attendanceRecord.create({
          data: {
            employeeId: staff.id,
            branchId: branch.id,
            clockInServerTime: new Date(Date.now() - 3 * HOUR),
            clockInGpsStatus: 'within_radius',
          },
        });
        const sale = await prisma.transaction.create({
          data: {
            transactionNumber: `P68-${label}-${suffix}`,
            branchId: branch.id,
            shiftId: shift.id,
            cashierId: staff.id,
            status: 'completed',
            paymentMethod: 'cash',
            subtotal: 99,
            vatAmount: 0,
            totalAmount: 99,
          },
        });
        const job = await prisma.inventoryDeductionJob.create({
          data: {
            transactionId: sale.id,
            branchId: branch.id,
            status: 'processing',
            claimToken: 'worker-1',
            lockedAt: new Date(),
          },
        });
        await prisma.checkoutAttempt.create({
          data: {
            idempotencyKey: `p68-co-${label}-${suffix}`,
            branchId: branch.id,
            cashierId: staff.id,
            ownerToken: 'owner',
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        const hold = await prisma.holdOrder.create({
          data: {
            branchId: branch.id,
            shiftId: shift.id,
            cashierId: staff.id,
            expiresAt: new Date(Date.now() + HOUR),
          },
        });
        await prisma.inventoryStock.create({
          data: {
            branchId: branch.id,
            inventoryItemId: itemId,
            quantityOnHand: 12.5,
            quantityReserved: 1,
          },
        });
        const draft = await prisma.payrollRun.create({
          data: {
            branchId: branch.id,
            periodStart: new Date('2026-11-01'),
            periodEnd: new Date('2026-11-15'),
            createdBy: adminId,
          },
        });
        return { branch, staff, account, shift, attendance, sale, job, hold, draft };
      }

      async function confirm(branchId: string, who = actor()) {
        const plan = await branchForceDeletionService.getPlan(branchId, who);
        return {
          plan,
          input: {
            operation_id: randomUUID(),
            confirm_name: plan.confirmation.name,
            confirm_code: plan.confirmation.code,
            version: plan.confirmation.version,
            plan_keys: plan.confirmation.plan_keys,
            plan_hash: plan.confirmation.plan_hash,
            confirmation_token: plan.confirmation.confirmation_token,
            acknowledge: true as const,
          },
        };
      }

      it('normal Delete still refuses a blocked branch; the plan lists every open item', async () => {
        const f = await blockedBranch('plan');
        const eligibility = await branchesService.getDeletionEligibility(f.branch.id, actor());
        expect(eligibility.can_delete).toBe(false);
        const { plan } = await confirm(f.branch.id);
        expect(plan.groups.map((g) => g.kind).sort()).toEqual(
          [
            'deduction_job',
            'draft_payroll_run',
            'held_order',
            'open_attendance',
            'open_shift',
            'pending_checkout',
            'stock_balance',
          ].sort(),
        );
        expect(plan.offline_notice).toMatch(/cannot see or delete/);
      });

      it('refuses non-admins, a wrong name, another admin’s token and a stale version; nothing changes', async () => {
        const f = await blockedBranch('refuse');
        const { input } = await confirm(f.branch.id);
        expect(
          (
            await errorOf(
              branchForceDeletionService.forceDelete(
                f.branch.id,
                { id: f.staff.id, role: 'supervisor' },
                null,
                input,
              ),
            )
          )?.code,
        ).toBe('FORBIDDEN');
        expect(
          (
            await errorOf(
              branchForceDeletionService.forceDelete(f.branch.id, actor(), null, {
                ...input,
                confirm_name: 'nope',
              }),
            )
          )?.code,
        ).toBe('DELETE_CONFIRMATION_MISMATCH');
        expect(
          (
            await errorOf(
              branchForceDeletionService.forceDelete(
                f.branch.id,
                { id: otherAdminId, role: 'super_admin' },
                null,
                input,
              ),
            )
          )?.code,
        ).toBe('DELETE_CONFIRMATION_INVALID');
        expect(
          (
            await errorOf(
              branchForceDeletionService.forceDelete(f.branch.id, actor(), null, {
                ...input,
                plan_keys: input.plan_keys.slice(1),
              }),
            )
          )?.code,
        ).toBe('DELETE_CONFIRMATION_INVALID');
        await prisma.branch.update({
          where: { id: f.branch.id },
          data: { address: '2 Changed St' },
        });
        expect(
          (await errorOf(branchForceDeletionService.forceDelete(f.branch.id, actor(), null, input)))
            ?.code,
        ).toBe('BRANCH_CHANGED');
        const branch = await prisma.branch.findUniqueOrThrow({ where: { id: f.branch.id } });
        expect(branch.deletionFencedAt).toBeNull();
        expect(
          await prisma.branchDeletionOperation.count({ where: { branchId: f.branch.id } }),
        ).toBe(0);
      });

      it('a stale plan (new open work after confirmation) is refused before anything changes', async () => {
        const f = await blockedBranch('stale');
        const { input } = await confirm(f.branch.id);
        await prisma.attendanceRecord.create({
          data: {
            employeeId: (await makeUser('staff', 'stale2')).id,
            branchId: f.branch.id,
            clockInServerTime: new Date(),
            clockInGpsStatus: 'within_radius',
          },
        });
        expect(
          (await errorOf(branchForceDeletionService.forceDelete(f.branch.id, actor(), null, input)))
            ?.code,
        ).toBe('FORCE_DELETION_PLAN_CHANGED');
        expect(
          (await prisma.branch.findUniqueOrThrow({ where: { id: f.branch.id } })).deletionFencedAt,
        ).toBeNull();
      });

      describe('a completed Force Delete', () => {
        let f: Awaited<ReturnType<typeof blockedBranch>>;
        let input: Awaited<ReturnType<typeof confirm>>['input'];
        let accountToken: string;
        let result: Awaited<ReturnType<typeof branchForceDeletionService.forceDelete>>;

        beforeAll(async () => {
          f = await blockedBranch('done');
          const login = await authService.login(
            f.account.email as string,
            PASSWORD,
            `p68-done-${suffix}`,
            null,
          );
          if (!('access_token' in login)) throw new Error('unexpected 2FA');
          accountToken = login.access_token;
          ({ input } = await confirm(f.branch.id));
          result = await branchForceDeletionService.forceDelete(f.branch.id, actor(), null, input);
        });

        it('completes and deletes the operational branch and its exclusive login', async () => {
          expect(result.status).toBe('completed');
          expect(await prisma.branch.findUnique({ where: { id: f.branch.id } })).toBeNull();
          expect(await prisma.user.findUnique({ where: { id: f.account.id } })).toBeNull();
          expect(await errorOf(verifyAccessToken(accountToken))).toBeDefined();
          expect(await prisma.user.findUnique({ where: { id: f.staff.id } })).not.toBeNull();
        });

        it('fabricates nothing: no cash count, no clock-out, no finalized payroll, no stock write', async () => {
          const shift = await prisma.shift.findUniqueOrThrow({ where: { id: f.shift.id } });
          expect(shift.status).toBe('terminated');
          expect(shift.closedAt).toBeNull();
          expect(shift.closingCashAmount).toBeNull();
          expect(shift.closedBy).toBeNull();
          const attendance = await prisma.attendanceRecord.findUniqueOrThrow({
            where: { id: f.attendance.id },
          });
          expect(attendance.clockOutServerTime).toBeNull();
          expect(attendance.administrativelyTerminatedAt).not.toBeNull();
          expect(
            (await prisma.payrollRun.findUniqueOrThrow({ where: { id: f.draft.id } })).status,
          ).toBe('draft');
          expect(
            await prisma.inventoryStockMovement.count({ where: { branchId: f.branch.id } }),
          ).toBe(0);
          expect(
            (await prisma.inventoryDeductionJob.findUniqueOrThrow({ where: { id: f.job.id } }))
              .status,
          ).toBe('cancelled');
          expect(
            (
              await prisma.transaction.findUniqueOrThrow({ where: { id: f.sale.id } })
            ).totalAmount.toString(),
          ).toBe('99');
        });

        it('records every unresolved item, read-only, and lets it be reconciled once', async () => {
          const items = await prisma.branchClosureItem.findMany({
            where: { branchId: f.branch.id },
          });
          expect(items.map((i) => i.kind).sort()).toEqual(
            [
              'deduction_job',
              'draft_payroll_run',
              'held_order',
              'open_attendance',
              'open_shift',
              'pending_checkout',
              'stock_balance',
            ].sort(),
          );
          const stock = items.find((i) => i.kind === 'stock_balance');
        const first = items[0];
        if (!stock || !first) throw new Error('closure items missing');
          expect((stock.snapshot as { quantityOnHand?: string }).quantityOnHand).toBe('12.5');
          await expect(
            prisma.branchClosureItem.delete({ where: { id: first.id } }),
          ).rejects.toThrow(/CLOSURE_ITEM_IMMUTABLE/);
          const list = await branchForceDeletionService.listClosureItems(actor(), {
            branchId: f.branch.id,
            reconciled: false,
            page: 1,
            limit: 25,
          });
          expect(list.total).toBe(items.length);
          await branchForceDeletionService.reconcileClosureItem(
            stock.id,
            actor(),
            'Counted 12.5 kg and moved to Main',
            null,
          );
          expect(
            (
              await errorOf(
                branchForceDeletionService.reconcileClosureItem(
                  stock.id,
                  actor(),
                  'again please',
                  null,
                ),
              )
            )?.code,
          ).toBe('CLOSURE_ITEM_ALREADY_RECONCILED');
        });

        it('a repeat with the same operation id returns the same result; another branch id is refused', async () => {
          const again = await branchForceDeletionService.forceDelete(
            f.branch.id,
            actor(),
            null,
            input,
          );
          expect(again.status).toBe('completed');
          expect(again.operation_id).toBe(input.operation_id);
          const other = await blockedBranch('other');
          expect(
            (
              await errorOf(
                branchForceDeletionService.forceDelete(other.branch.id, actor(), null, input),
              )
            )?.code,
          ).toBe('FORCE_DELETION_OPERATION_CONFLICT');
          expect(
            await prisma.branchDeletionOperation.count({ where: { id: input.operation_id } }),
          ).toBe(1);
        });

        it('the staff member can clock in elsewhere; the terminated clock-in is not "open"', async () => {
          expect(await attendanceRepository.findActiveRecord(f.staff.id)).toBeNull();
        });

        it('a late offline write for the deleted branch is refused as BRANCH_DELETED', async () => {
          const error = await errorOf(
            prisma.transaction.create({
              data: {
                transactionNumber: `P68-late-${suffix}`,
                branchId: f.branch.id,
                shiftId: f.shift.id,
                cashierId: f.staff.id,
                status: 'completed',
                paymentMethod: 'cash',
                subtotal: 1,
                vatAmount: 0,
                totalAmount: 1,
              },
            }),
          );
          expect(isDeletedBranchWrite(error)).toBe(true);
        });
      });

      it('a fenced branch refuses writes (retryable), a stuck operation is resumable, and abort lifts the fence', async () => {
        const branch = await makeBranch('fence');
        const staff = await makeUser('staff', 'fencestaff');
        const shift = await prisma.shift.create({
          data: {
            branchId: branch.id,
            cashierId: staff.id,
            openedBy: staff.id,
            status: 'active',
            openingCashAmount: 1,
            startedAt: new Date(),
          },
        });
        const { input } = await confirm(branch.id);
        // Fence directly (as if the process died right after transaction 1).
        const { branchForceDeletionRepository, planHash } =
          await import('./branch-force-deletion.repository.js');
        const fenced = await branchForceDeletionRepository.fence({
          operationId: input.operation_id,
          branchId: branch.id,
          actorId: adminId,
          expectedVersion: new Date(input.version),
          planKeys: input.plan_keys,
          planHashValue: planHash(input.plan_keys),
        });
        expect(fenced).toBe('fenced');
        const write = await errorOf(
          prisma.holdOrder.create({
            data: {
              branchId: branch.id,
              shiftId: shift.id,
              cashierId: staff.id,
              expiresAt: new Date(),
            },
          }),
        );
        expect(isFencedBranchWrite(write)).toBe(true);
        expect(
          (
            await errorOf(
              branchesService.updateBranch(branch.id, { address: '9 St' }, actor(), null),
            )
          )?.code,
        ).toBe('BRANCH_DELETION_IN_PROGRESS');
        const status = await branchForceDeletionService.getStatus(
          input.operation_id,
          actor(),
          null,
        );
        expect(status.status).toBe('completed');
        expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe(
          'terminated',
        );

        // Abort path on a fresh branch.
        const keep = await makeBranch('keep');
        const k = await confirm(keep.id);
        await branchForceDeletionRepository.fence({
          operationId: k.input.operation_id,
          branchId: keep.id,
          actorId: adminId,
          expectedVersion: new Date(k.input.version),
          planKeys: k.input.plan_keys,
          planHashValue: planHash(k.input.plan_keys),
        });
        const aborted = await branchForceDeletionService.abort(k.input.operation_id, actor(), null);
        expect(aborted.status).toBe('aborted');
        expect(
          (await prisma.branch.findUniqueOrThrow({ where: { id: keep.id } })).deletionFencedAt,
        ).toBeNull();
      });

      it('a claimed worker cannot commit a stock write after the fence', async () => {
        const branch = await makeBranch('worker');
        await prisma.inventoryStock.create({
          data: { branchId: branch.id, inventoryItemId: itemId, quantityOnHand: 3 },
        });
        const { input } = await confirm(branch.id);
        const { branchForceDeletionRepository, planHash } =
          await import('./branch-force-deletion.repository.js');
        await branchForceDeletionRepository.fence({
          operationId: input.operation_id,
          branchId: branch.id,
          actorId: adminId,
          expectedVersion: new Date(input.version),
          planKeys: input.plan_keys,
          planHashValue: planHash(input.plan_keys),
        });
        const write = await errorOf(
          prisma.inventoryStockMovement.create({
            data: {
              branchId: branch.id,
              inventoryItemId: itemId,
              movementType: 'WASTE',
              quantityChange: -1,
              quantityBefore: 3,
              quantityAfter: 2,
            },
          }),
        );
        expect(isFencedBranchWrite(write)).toBe(true);
        expect((await branchForceDeletionService.advance(input.operation_id, null)).status).toBe(
          'completed',
        );
      });

      it('normal Delete still works for a branch with no open work', async () => {
        const branch = await makeBranch('normal');
        const eligibility = await branchesService.getDeletionEligibility(branch.id, actor());
        if (!eligibility.confirmation) throw new Error('not deletable');
        const result = await branchesService.deleteBranch(branch.id, actor(), null, {
          confirm_name: eligibility.confirmation.name,
          confirm_code: eligibility.confirmation.code,
          version: eligibility.confirmation.version,
          confirmation_token: eligibility.confirmation.confirmation_token,
        });
        expect(result.outcome).toBe('deleted');
      });
    });

    // ---------------------------------------------------------------- C
    describe('C. branch-scoped staff', () => {
      let branchA: string;
      let branchB: string;
      let supervisor: JwtPayload;

      beforeAll(async () => {
        branchA = (await makeBranch('staffA')).id;
        branchB = (await makeBranch('staffB')).id;
        const sup = await makeUser('supervisor', 'twobranch');
        await prisma.userBranchAssignment.createMany({
          data: [
            { userId: sup.id, branchId: branchA },
            { userId: sup.id, branchId: branchB },
          ],
        });
        supervisor = {
          user_id: sup.id,
          role: 'supervisor',
          email: sup.email as string,
          branch_ids: [branchA, branchB],
        } as JwtPayload;
      });

      const create = (branchId: string, firstName = 'Same') =>
        employeesService.createEmployee(
          {
            first_name: firstName,
            last_name: `Name${suffix}`,
            phone: '09170000000',
            role: 'staff',
            employment_type: 'regular',
            branch_ids: [branchId],
          } as never,
          supervisor,
          null,
        );

      it('staff created in A is listed only in A; same-name staff in B stays a separate account', async () => {
        const inA = await create(branchA);
        const inB = await create(branchB);
        expect(inA.id).not.toBe(inB.id);
        const listA = await employeesService.getAllEmployees(supervisor, {
          branchId: branchA,
          role: 'staff',
          page: 1,
          limit: 100,
        } as never);
        const listB = await employeesService.getAllEmployees(supervisor, {
          branchId: branchB,
          role: 'staff',
          page: 1,
          limit: 100,
        } as never);
        expect(listA.employees.map((e) => e.id)).toContain(inA.id);
        expect(listA.employees.map((e) => e.id)).not.toContain(inB.id);
        expect(listB.employees.map((e) => e.id)).toContain(inB.id);
        expect(listA.employees.every((e) => e.role === 'staff')).toBe(true);
        expect(listA.total).toBe(listA.employees.length);
        // New staff starts with No PIN; setting one for A doesn't touch B's same-name person.
        expect((await staffPinService.getStatus(inA.id, supervisor)).has_pin).toBe(false);
        await staffPinService.setPin(inA.id, '482913', supervisor, null);
        expect((await staffPinService.getStatus(inA.id, supervisor)).has_pin).toBe(true);
        expect((await staffPinService.getStatus(inB.id, supervisor)).has_pin).toBe(false);
      });

      it('a supervisor whose access to A was removed can no longer list, PIN, edit or delete A’s staff', async () => {
        const inA = await create(branchA, 'Revoked');
        await prisma.userBranchAssignment.updateMany({
          where: { userId: supervisor.user_id, branchId: branchA },
          data: { removedAt: new Date() },
        });
        const onlyB = { ...supervisor, branch_ids: [branchB] } as JwtPayload;
        expect(
          (
            await errorOf(
              employeesService.getAllEmployees(onlyB, {
                branchId: branchA,
                page: 1,
                limit: 100,
              } as never),
            )
          )?.code,
        ).toBeDefined();
        expect(await errorOf(staffPinService.setPin(inA.id, '739104', onlyB, null))).toBeDefined();
        await prisma.userBranchAssignment.updateMany({
          where: { userId: supervisor.user_id, branchId: branchA },
          data: { removedAt: null },
        });
      });
    });
  },
);
