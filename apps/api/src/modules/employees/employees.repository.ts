import type { Prisma, EmployeeStatus as PrismaEmployeeStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { nextCounterValue } from '../../lib/id-counter.js';
import { monthBounds } from '../../lib/manila-time.js';
import { REMOVED_ACCOUNT_MARKER_TTL_MS, removedAccountRevocationHash } from '../../lib/verify-access-token.js';
import type {
  CreateEmployeeData,
  EmployeeActivityData,
  EmployeeHistoryCategory,
  EmployeeListFilters,
  UpdateEmployeeData,
} from './employees.types.js';

/**
 * Standard employee select — deliberately excludes every *_encrypted
 * government ID column. Government ID fields must never appear in a
 * standard API response (locked rule); findWithGovernmentIds is the one,
 * distinctly-named exception, reserved for the payroll export path.
 */
const employeeSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  employmentType: true,
  employeeId: true,
  position: true,
  notes: true,
  isActive: true,
  status: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  deletedAt: true,
  branchAssignments: {
    where: { removedAt: null },
    select: {
      branchId: true,
      assignedAt: true,
      branch: { select: { name: true, code: true } },
    },
  },
} satisfies Prisma.UserSelect;

export type EmployeeWithAssignments = Prisma.UserGetPayload<{ select: typeof employeeSelect }>;

const employeeWithGovernmentIdsSelect = {
  ...employeeSelect,
  sssNumberEncrypted: true,
  philhealthNumberEncrypted: true,
  tinNumberEncrypted: true,
  pagibigNumberEncrypted: true,
} satisfies Prisma.UserSelect;

export type EmployeeWithGovernmentIds = Prisma.UserGetPayload<{ select: typeof employeeWithGovernmentIdsSelect }>;

/** Composes as AND-of-conditions (rather than one flat object) so `role` and `excludeRoles` can both apply without one clobbering the other. */
function buildWhere(
  filters: Pick<EmployeeListFilters, 'role' | 'employmentType' | 'isActive' | 'branchIds' | 'excludeRoles' | 'search'>,
): Prisma.UserWhereInput {
  // POS-PERF-P64 — removed accounts never appear in operational lists,
  // selectors, search results or their counts. History screens resolve
  // names by id through their own joins and keep showing them.
  const and: Prisma.UserWhereInput[] = [{ deletedAt: null }];

  if (filters.role) and.push({ role: filters.role });
  if (filters.employmentType) and.push({ employmentType: filters.employmentType });
  if (filters.isActive !== undefined) and.push({ isActive: filters.isActive });
  if (filters.branchIds) and.push({ branchAssignments: { some: { branchId: { in: filters.branchIds }, removedAt: null } } });
  if (filters.excludeRoles && filters.excludeRoles.length > 0) and.push({ role: { notIn: filters.excludeRoles } });
  if (filters.search) {
    and.push({
      OR: [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { employeeId: { contains: filters.search, mode: 'insensitive' } },
      ],
    });
  }

  return { AND: and };
}

export interface RemovalPrerequisites {
  /** Blocking: close the shift (count the cash) first. */
  open_shifts: { id: string; branch_name: string }[];
  /** Blocking: clock out (or correct the record) first. */
  open_attendance: { id: string; branch_name: string }[];
  /** Informational: held carts expire on their own and stay on their branch. */
  held_orders: number;
  /** Informational: reviewers can still decide them; the requester name is kept. */
  pending_inventory_approvals: number;
  /** Branches whose access is removed. */
  branches: { id: string; name: string }[];
  /** Informational: no other active supervisor is assigned; a Super Admin can assign one. */
  branches_left_without_supervisor: { id: string; name: string }[];
}

/** Thrown inside the removal transaction to roll it back; never escapes the repository. */
class RemovalBlocked extends Error {
  constructor(public readonly prerequisites: RemovalPrerequisites) {
    super('removal blocked');
  }
}

/** POS-PERF-P64 — an ordinary write met an account that a Super Admin has removed. */
export class AccountRemovedError extends Error {
  constructor() {
    super('This account has been removed');
    this.name = 'AccountRemovedError';
  }
}

/**
 * POS-PERF-P64 — takes the user's row lock and refuses a removed account, so
 * a branch assignment racing a removal is serialised behind it. The no-op
 * write (deletedAt stays NULL) is what takes the lock.
 */
export async function lockNonRemovedUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const locked = await tx.user.updateMany({ where: { id: userId, deletedAt: null }, data: { deletedAt: null } });
  if (locked.count === 0) throw new AccountRemovedError();
}

/**
 * Employees repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const employeesRepository = {
  async findAll(filters: EmployeeListFilters) {
    const where = buildWhere(filters);

    const [employees, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        select: employeeSelect,
      }),
      prisma.user.count({ where }),
    ]);

    return { employees, total };
  },

  findById(id: string) {
    return prisma.user.findUnique({ where: { id }, select: employeeSelect });
  },

  /** Minimal projection for requireActiveEmployee's per-request status re-check — avoids the full employeeSelect (branch assignments, etc.) on every hot-path POS/attendance request. */
  findStatusById(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { status: true, isActive: true, deletedAt: true } });
  },

  /** Used only in auth context (includes passwordHash) — never for populating an API response. */
  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  /**
   * Distinctly named on purpose: this is the ONE repository function that
   * returns the encrypted government ID columns. Called only from
   * employeesService.getEmployeePayrollData.
   */
  findWithGovernmentIds(id: string) {
    return prisma.user.findUnique({ where: { id }, select: employeeWithGovernmentIdsSelect });
  },

  findByBranchIds(branchIds: string[]) {
    return prisma.user.findMany({
      where: { isActive: true, deletedAt: null, branchAssignments: { some: { branchId: { in: branchIds }, removedAt: null } } },
      orderBy: { firstName: 'asc' },
      select: employeeSelect,
    });
  },

  /**
   * Atomically allocates the next employee number — two concurrent create
   * requests can never receive the same number because the underlying
   * INSERT ... ON CONFLICT is a single atomic statement server-side (Phase
   * 21: Postgres replacement for Redis INCR). Same pattern as
   * branches.repository.ts's generateBranchCode.
   */
  async generateEmployeeId(): Promise<string> {
    const next = await nextCounterValue('employee_id_counter');
    return `PC-EMP-${String(next).padStart(6, '0')}`;
  },

  /**
   * Task 174 — accepts an optional transaction client so branchesService can
   * create a branch's login account inside the SAME transaction as the
   * branch row itself (atomic branch+account creation, no orphan branch if
   * account creation fails). Without a `tx`, this opens its own transaction
   * as before — the two writes below must always commit or roll back together.
   */
  create(data: CreateEmployeeData, tx?: Prisma.TransactionClient) {
    if (tx) return employeesRepository.createInTx(tx, data);
    return prisma.$transaction((innerTx) => employeesRepository.createInTx(innerTx, data));
  },

  async createInTx(tx: Prisma.TransactionClient, data: CreateEmployeeData) {
    const user = await tx.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        role: data.role,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        employeeId: data.employeeId,
        employmentType: data.employmentType,
        position: data.position,
        notes: data.notes,
        sssNumberEncrypted: data.sssNumberEncrypted,
        philhealthNumberEncrypted: data.philhealthNumberEncrypted,
        tinNumberEncrypted: data.tinNumberEncrypted,
        pagibigNumberEncrypted: data.pagibigNumberEncrypted,
        // `staff` (Employees) never have credentials, so there is no
        // password to force a change on — only true when one was actually set.
        mustChangePassword: Boolean(data.passwordHash),
      },
    });

    await tx.userBranchAssignment.createMany({
      data: data.branchIds.map((branchId) => ({ userId: user.id, branchId, assignedAt: new Date() })),
    });

    return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: employeeSelect });
  },

  // POS-PERF-P64 — every ordinary write below matches only a non-removed row,
  // so a request that read the account just before a concurrent removal fails
  // with P2025 (mapped to EMPLOYEE_REMOVED) instead of changing a removed
  // account. The CHECK constraint is the database-level backstop.
  update(id: string, data: UpdateEmployeeData) {
    return prisma.user.update({ where: { id, deletedAt: null }, data, select: employeeSelect });
  },

  /** Single-column write for Branch Account credential edit — email is otherwise immutable via update() (UpdateEmployeeData excludes it). */
  updateEmail(id: string, email: string) {
    return prisma.user.update({ where: { id, deletedAt: null }, data: { email }, select: employeeSelect });
  },

  deactivate(id: string, deactivatedBy: string, reason: string) {
    return prisma.user.update({
      where: { id, deletedAt: null },
      data: { isActive: false, status: 'inactive', deactivatedAt: new Date(), deactivatedBy, deactivationReason: reason },
      select: employeeSelect,
    });
  },

  /**
   * Sets the full 5-state lifecycle status (Branch Operating System / CR-003).
   * isActive stays in sync (true only for 'active') so every existing
   * isActive-based check (auth.service.ts login gate, cashier eligibility,
   * dashboard queries) keeps working unmodified. deactivatedAt/By/Reason are
   * populated for any non-active status, mirroring the existing deactivate()
   * behavior, and cleared only when the status returns to 'active'.
   */
  setStatus(id: string, status: PrismaEmployeeStatus, changedBy: string, reason: string | null) {
    const isActive = status === 'active';
    return prisma.user.update({
      where: { id, deletedAt: null },
      data: isActive
        ? {
            isActive: true,
            status,
            deactivatedAt: null,
            deactivatedBy: null,
            deactivationReason: null,
            mustChangePassword: true,
          }
        : {
            isActive: false,
            status,
            deactivatedAt: new Date(),
            deactivatedBy: changedBy,
            deactivationReason: reason,
          },
      select: employeeSelect,
    });
  },

  /** reactivatedBy is not stored on the row itself — the caller's audit log entry is the record of who reactivated the account. */
  reactivate(id: string, reactivatedBy: string) {
    void reactivatedBy;
    return prisma.user.update({
      where: { id, deletedAt: null },
      data: {
        isActive: true,
        deactivatedAt: null,
        deactivatedBy: null,
        deactivationReason: null,
        // Reactivated accounts must set a fresh password before doing anything else (locked rule).
        mustChangePassword: true,
      },
      select: employeeSelect,
    });
  },

  /** updatedBy is not stored per-assignment — the caller's audit log entry is the record of who changed it. */
  async updateBranchAssignments(userId: string, branchIds: string[], updatedBy: string) {
    void updatedBy;
    return prisma.$transaction(async (tx) => {
      if (branchIds.length > 0) await lockNonRemovedUser(tx, userId);
      await tx.userBranchAssignment.updateMany({
        where: { userId, removedAt: null },
        data: { removedAt: new Date() },
      });

      if (branchIds.length === 0) return [];

      await tx.userBranchAssignment.createMany({
        data: branchIds.map((branchId) => ({ userId, branchId, assignedAt: new Date() })),
      });

      return tx.userBranchAssignment.findMany({ where: { userId, removedAt: null } });
    });
  },

  /**
   * Branch Operating System gap fix (Task 209.x incident, 2026-08-13): a
   * `branch` account is 1:1 with its branch — deactivation always clears its
   * one assignment via updateBranchAssignments(userId, [], ...), but neither
   * reactivate() nor setStatus('active') ever restored it, so a reactivated
   * branch account came back with no branch and couldn't operate. Restores
   * the most recently removed assignment — a no-op if one is already active
   * (nothing to restore) or none was ever removed (e.g. a brand-new account).
   * Deliberately not used for supervisor/staff: their reactivation should
   * stay a conscious re-assignment by an admin, not an automatic one.
   */
  async restoreMostRecentBranchAssignment(userId: string): Promise<void> {
    const activeCount = await prisma.userBranchAssignment.count({ where: { userId, removedAt: null } });
    if (activeCount > 0) return;

    const lastRemoved = await prisma.userBranchAssignment.findFirst({
      where: { userId, removedAt: { not: null } },
      orderBy: { removedAt: 'desc' },
    });
    if (!lastRemoved) return;

    await prisma.userBranchAssignment.update({ where: { id: lastRemoved.id }, data: { removedAt: null } });
  },

  /**
   * POS-PERF-P47 — every record that attributes something to this person,
   * grouped into the categories the UI explains. Any non-zero count means
   * the account must be deactivated rather than permanently deleted:
   * deleting it would orphan (or, for FK'd tables, be refused by) the
   * sales / attendance / audit history that names it. Includes the
   * non-FK user-id columns (inventory movements, approvals, catalog
   * ownership, settings) that Postgres itself would not protect.
   */
  async countHistoryReferences(
    userId: string,
    client: Prisma.TransactionClient = prisma,
  ): Promise<Record<EmployeeHistoryCategory, number>> {
    const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);
    const [sales, shifts, attendance, audit, inventory, expenses, catalog, settings, pinUse] = await Promise.all([
      Promise.all([
        client.transaction.count({
          where: { OR: [{ cashierId: userId }, { voidedById: userId }, { refundedById: userId }, { paymentProofVerifiedById: userId }] },
        }),
        client.checkoutAttempt.count({ where: { cashierId: userId } }),
        client.holdOrder.count({ where: { cashierId: userId } }),
      ]).then(sum),
      Promise.all([
        client.shift.count({
          where: { OR: [{ cashierId: userId }, { openedBy: userId }, { closedBy: userId }, { varianceApprovedBy: userId }] },
        }),
        client.shiftReview.count({ where: { reviewedBy: userId } }),
      ]).then(sum),
      client.attendanceRecord.count({ where: { OR: [{ employeeId: userId }, { correctedBy: userId }] } }),
      Promise.all([
        client.auditLog.count({ where: { actorId: userId } }),
        client.auditOutbox.count({ where: { actorId: userId } }),
        client.fraudAlert.count({ where: { OR: [{ employeeId: userId }, { investigatedBy: userId }] } }),
      ]).then(sum),
      Promise.all([
        client.inventoryStockMovement.count({ where: { OR: [{ performedByUserId: userId }, { responsibleUserId: userId }] } }),
        client.inventoryMovement.count({ where: { OR: [{ approvedBy: userId }, { recordedBy: userId }] } }),
        client.inventoryApprovalRequest.count({
          where: {
            OR: [
              { submittedByUserId: userId },
              { reviewedByUserId: userId },
              { cancelledByUserId: userId },
              { responsibleStaffUserId: userId },
            ],
          },
        }),
        client.inventoryCostCorrection.count({ where: { correctedByUserId: userId } }),
        client.inventoryOperationAttempt.count({ where: { actorUserId: userId } }),
        client.inventoryEvidenceUpload.count({ where: { uploadedByUserId: userId } }),
        client.inventoryIdentityMapping.count({ where: { reviewedBy: userId } }),
      ]).then(sum),
      client.expense.count({ where: { createdBy: userId } }),
      Promise.all([
        client.product.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.productCategory.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.productOptionGroup.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.productOption.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.productVariantOptionGroup.count({ where: { createdBy: userId } }),
        client.productVariant.count({ where: { OR: [{ createdById: userId }, { approvedById: userId }] } }),
        client.productInventory.count({ where: { OR: [{ createdBy: userId }, { updatedBy: userId }] } }),
        client.productComponent.count({ where: { OR: [{ createdBy: userId }, { updatedBy: userId }] } }),
        client.productChangeLog.count({ where: { changedById: userId } }),
        client.inventoryCategory.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.unitOfMeasure.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.unitConversion.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.inventoryItem.count({ where: { OR: [{ createdBy: userId }, { managedBy: userId }] } }),
        client.catalogManagementAssignment.count({
          where: { OR: [{ previousManagedBy: userId }, { newManagedBy: userId }, { assignedBy: userId }] },
        }),
        client.branchProductAvailability.count({ where: { updatedBy: userId } }),
      ]).then(sum),
      Promise.all([
        client.systemSetting.count({ where: { updatedBy: userId } }),
        client.branchReceiptConfig.count({ where: { updatedBy: userId } }),
        client.branchPaymentMethodConfig.count({ where: { updatedBy: userId } }),
        client.initializationRun.count({ where: { initiatedBy: userId } }),
        client.staffPin.count({ where: { setByUserId: userId, userId: { not: userId } } }),
        client.user.count({ where: { deactivatedBy: userId, id: { not: userId } } }),
      ]).then(sum),
      // A PIN that was ever verified (inventory or POS) is operational
      // history too — deleting the StaffPin would cascade those rows away.
      client.staffPinVerification.count({ where: { staffPin: { userId } } }),
    ]);
    return { sales, shifts, attendance, audit, inventory, expenses, catalog, settings, pin_use: pinUse };
  },

  /**
   * POS-PERF-P47 — permanent delete of a never-used account. Re-checks the
   * history references inside the same transaction and removes only the
   * rows that belong to the account itself (sessions, reset tokens, PIN,
   * branch assignments, its notifications). Returns the blocking counts
   * instead of deleting when any history exists; a concurrent write that
   * lands on an FK'd table is still refused by Postgres (P2003) and rolls
   * the whole transaction back.
   */
  async hardDeleteUnused(
    userId: string,
  ): Promise<{ deleted: true } | { deleted: false; references: Record<EmployeeHistoryCategory, number> }> {
    return prisma.$transaction(async (tx) => {
      const references = await employeesRepository.countHistoryReferences(userId, tx);
      if (Object.values(references).some((count) => count > 0)) return { deleted: false as const, references };

      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.pinCredential.deleteMany({ where: { userId } });
      await tx.staffPin.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { recipientUserId: userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.expenseIdempotencyKey.deleteMany({ where: { userId } });
      await tx.userBranchAssignment.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
      return { deleted: true as const };
    });
  },

  /**
   * POS-PERF-P64 — what stands in the way of removing this account, and what
   * the person deciding should know. Only real integrity problems block:
   * an open shift (cash still to count) and an open clock-in (time still
   * running). Everything else is reported, never silently changed.
   */
  async getRemovalPrerequisites(userId: string, client: Prisma.TransactionClient = prisma): Promise<RemovalPrerequisites> {
    const [openShifts, openAttendance, heldOrders, pendingApprovals, assignments] = await Promise.all([
      client.shift.findMany({
        where: { status: 'active', OR: [{ cashierId: userId }, { openedBy: userId }] },
        select: { id: true, branch: { select: { name: true } } },
      }),
      client.attendanceRecord.findMany({
        where: { employeeId: userId, clockOutServerTime: null, deletedAt: null },
        select: { id: true, branch: { select: { name: true } } },
      }),
      client.holdOrder.count({ where: { cashierId: userId, status: 'held' } }),
      client.inventoryApprovalRequest.count({ where: { submittedByUserId: userId, status: 'PENDING' } }),
      client.userBranchAssignment.findMany({
        where: { userId, removedAt: null },
        select: { branchId: true, branch: { select: { name: true } } },
      }),
    ]);
    const branchIds = assignments.map((a) => a.branchId);
    const coveringAssignments = branchIds.length
      ? await client.userBranchAssignment.findMany({
          where: {
            branchId: { in: branchIds },
            removedAt: null,
            userId: { not: userId },
            user: { role: 'supervisor', isActive: true, deletedAt: null },
          },
          select: { branchId: true },
        })
      : [];
    const covered = new Set(coveringAssignments.map((row) => row.branchId));
    return {
      open_shifts: openShifts.map((s) => ({ id: s.id, branch_name: s.branch.name })),
      open_attendance: openAttendance.map((a) => ({ id: a.id, branch_name: a.branch.name })),
      held_orders: heldOrders,
      pending_inventory_approvals: pendingApprovals,
      branches: assignments.map((a) => ({ id: a.branchId, name: a.branch.name })),
      branches_left_without_supervisor: assignments
        .filter((a) => !covered.has(a.branchId))
        .map((a) => ({ id: a.branchId, name: a.branch.name })),
    };
  },

  /**
   * POS-PERF-P64 — removes an account that has history, keeping the row as
   * a non-login historical record. One transaction: the first write takes
   * the row lock (serialising concurrent removals, edits, status changes and
   * branch assignments), the prerequisites are re-checked under it, then
   * sessions, reset tokens, device PINs and branch access are removed.
   * Nothing that names the person (sales, expenses, attendance, payroll,
   * stock movements, proofs, audit) is touched. Returns 'already_removed'
   * when a concurrent request removed it first, and 'blocked' (with nothing
   * changed) when a prerequisite fails.
   */
  async removeWithHistory(
    userId: string,
    removedBy: string,
    previous: { isActive: boolean; status: PrismaEmployeeStatus },
  ): Promise<
    | { outcome: 'removed'; prerequisites: RemovalPrerequisites }
    | { outcome: 'already_removed' }
    | { outcome: 'blocked'; prerequisites: RemovalPrerequisites }
  > {
    const now = new Date();
    try {
      return await prisma.$transaction(async (tx) => {
        const marked = await tx.user.updateMany({
          where: { id: userId, deletedAt: null },
          data: {
            deletedAt: now,
            deletedBy: removedBy,
            isActive: false,
            status: previous.status === 'active' ? 'inactive' : previous.status,
            ...(previous.isActive
              ? { deactivatedAt: now, deactivatedBy: removedBy, deactivationReason: 'Account removed by Super Admin' }
              : {}),
          },
        });
        if (marked.count === 0) return { outcome: 'already_removed' as const };

        const prerequisites = await employeesRepository.getRemovalPrerequisites(userId, tx);
        if (prerequisites.open_shifts.length > 0 || prerequisites.open_attendance.length > 0) {
          throw new RemovalBlocked(prerequisites);
        }

        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
        await tx.passwordResetToken.deleteMany({ where: { userId } });
        await tx.pinCredential.deleteMany({ where: { userId } });
        await tx.userBranchAssignment.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } });
        // Ends every already-issued access token for this account (checked by verifyAccessToken).
        const markerHash = removedAccountRevocationHash(userId);
        const markerExpiry = new Date(now.getTime() + REMOVED_ACCOUNT_MARKER_TTL_MS);
        await tx.revokedToken.upsert({
          where: { tokenHash: markerHash },
          create: { tokenHash: markerHash, expiresAt: markerExpiry },
          update: { expiresAt: markerExpiry },
        });
        return { outcome: 'removed' as const, prerequisites };
      });
    } catch (error) {
      if (error instanceof RemovalBlocked) return { outcome: 'blocked', prerequisites: error.prerequisites };
      throw error;
    }
  },

  async hasActiveShift(userId: string): Promise<boolean> {
    const count = await prisma.shift.count({ where: { cashierId: userId, status: 'active' } });
    return count > 0;
  },

  async getActivity(employeeId: string): Promise<EmployeeActivityData> {
    const { monthStart: startOfMonth } = monthBounds(new Date());

    const [lastTransaction, totalShiftsThisMonth, totalTransactionsThisMonth, openFraudAlertsCount] = await Promise.all([
      prisma.transaction.findFirst({
        where: { cashierId: employeeId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.shift.count({ where: { cashierId: employeeId, startedAt: { gte: startOfMonth } } }),
      prisma.transaction.count({ where: { cashierId: employeeId, createdAt: { gte: startOfMonth }, status: 'completed' } }),
      prisma.fraudAlert.count({ where: { employeeId, status: 'open' } }),
    ]);

    return {
      lastTransactionAt: lastTransaction?.createdAt ?? null,
      totalShiftsThisMonth,
      totalTransactionsThisMonth,
      openFraudAlertsCount,
    };
  },
};
