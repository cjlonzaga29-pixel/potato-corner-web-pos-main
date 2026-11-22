import type { Prisma, EmployeeStatus as PrismaEmployeeStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { nextCounterValue } from '../../lib/id-counter.js';
import { manilaDateKey, monthBounds } from '../../lib/manila-time.js';
import { REMOVED_ACCOUNT_MARKER_TTL_MS, removedAccountRevocationHash } from '../../lib/verify-access-token.js';
import type {
  CreateEmployeeData,
  EmployeeActivityData,
  EmployeeHistoryCategory,
  EmployeeListFilters,
  UpdateEmployeeData,
} from './employees.types.js';
import { hasBlockingPrerequisites, type RemovalPrerequisites } from './employees.types.js';

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
  // POS-PERF-P66 — the version a Delete confirmation is bound to.
  updatedAt: true,
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

export { hasBlockingPrerequisites, type RemovalPrerequisites } from './employees.types.js';

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
   * POS-PERF-P68 — who holds this login email, compared case-insensitively
   * (older rows may predate normalization). Returns only what the caller
   * needs to explain a conflict: never the password hash. `liveAssignments`
   * counts assignments that are not removed; assignment rows cascade with
   * their branch, so any row here points at a live branch.
   */
  async findEmailHolder(email: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
    const holder = await client.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        role: true,
        deletedAt: true,
        _count: { select: { branchAssignments: { where: { removedAt: null } } } },
      },
    });
    if (!holder) return null;
    return {
      id: holder.id,
      role: holder.role,
      deletedAt: holder.deletedAt,
      liveAssignments: holder._count.branchAssignments,
    };
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
   * grouped into the categories the UI explains. POS-PERF-P66: these never
   * block a delete any more (history references Person, which outlives the
   * account); the dialog shows them as the records that stay. Includes the
   * non-FK user-id columns (inventory movements, approvals, catalog
   * ownership, settings).
   */
  async countHistoryReferences(
    userId: string,
    client: Prisma.TransactionClient = prisma,
  ): Promise<Record<EmployeeHistoryCategory, number>> {
    const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);
    const [sales, shifts, attendance, audit, inventory, expenses, catalog, settings, pinUse, payroll] = await Promise.all([
      Promise.all([
        client.transaction.count({
          where: { OR: [{ cashierId: userId }, { voidedById: userId }, { refundedById: userId }, { paymentProofVerifiedById: userId }] },
        }),
        client.checkoutAttempt.count({ where: { cashierId: userId } }),
        client.holdOrder.count({ where: { cashierId: userId } }),
        // POS-PERF-P66 — FK'd tables P47 missed (their RESTRICT made a "no history" delete fail with a 500).
        client.discountProofUpload.count({ where: { uploadedById: userId } }),
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
        client.extraSupply.count({ where: { OR: [{ createdById: userId }, { updatedById: userId }] } }),
        client.extraSupplyIssue.count({ where: { cashierId: userId } }),
      ]).then(sum),
      Promise.all([
        client.expense.count({ where: { createdBy: userId } }),
        client.expenseType.count({ where: { OR: [{ createdById: userId }, { updatedById: userId }] } }),
      ]).then(sum),
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
        client.productType.count({ where: { OR: [{ createdById: userId }, { updatedById: userId }] } }),
        client.promotion.count({ where: { OR: [{ createdById: userId }, { updatedById: userId }] } }),
        client.manualDiscountType.count({
          where: { OR: [{ createdById: userId }, { updatedById: userId }, { deactivatedById: userId }] },
        }),
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
      Promise.all([
        client.employeePayRate.count({ where: { employeeId: userId } }),
        client.payrollRunLine.count({ where: { employeeId: userId } }),
        client.payrollAdjustment.count({ where: { employeeId: userId } }),
      ]).then(sum),
    ]);
    return { sales, shifts, attendance, audit, inventory, expenses, catalog, settings, pin_use: pinUse, payroll };
  },

  /**
   * POS-PERF-P64/P66 — what stands in the way of deleting this account, and
   * what the person deciding should know. Only real integrity problems block:
   * an open shift (cash still to count), an open clock-in (time still
   * running) and, for staff, recorded hours that no finalized payroll covers
   * yet. Everything else is reported, never silently changed.
   */
  async getRemovalPrerequisites(
    userId: string,
    client: Prisma.TransactionClient = prisma,
    role: string | null = null,
  ): Promise<RemovalPrerequisites> {
    const [openShifts, openAttendance, heldOrders, pendingApprovals, assignments, unpaidPayroll] =
      await Promise.all([
        client.shift.findMany({
          where: { status: 'active', OR: [{ cashierId: userId }, { openedBy: userId }] },
          select: { id: true, branch: { select: { name: true } } },
        }),
        client.attendanceRecord.findMany({
          where: {
            employeeId: userId,
            clockOutServerTime: null,
            deletedAt: null,
            administrativelyTerminatedAt: null,
          },
          select: { id: true, branch: { select: { name: true } } },
        }),
        client.holdOrder.count({ where: { cashierId: userId, status: 'held' } }),
        client.inventoryApprovalRequest.count({
          where: { submittedByUserId: userId, status: 'PENDING' },
        }),
        client.userBranchAssignment.findMany({
          where: { userId, removedAt: null },
          select: { branchId: true, branch: { select: { name: true } } },
        }),
        role === 'staff'
          ? employeesRepository.findUnpaidPayrollAttendance(userId, client)
          : Promise.resolve([]),
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
      branches_left_without_supervisor:
        role === 'supervisor'
          ? assignments.filter((a) => !covered.has(a.branchId)).map((a) => ({ id: a.branchId, name: a.branch.name }))
          : [],
      unpaid_payroll: unpaidPayroll,
    };
  },

  /**
   * POS-PERF-P66 — clocked-out attendance at a branch that uses payroll
   * (has a payroll policy; hours from before its first policy are out of
   * scope) whose Manila date falls in no finalized payroll run of that
   * branch. Grouped per branch with the date range, for the dialog.
   */
  async findUnpaidPayrollAttendance(
    userId: string,
    client: Prisma.TransactionClient = prisma,
  ): Promise<RemovalPrerequisites['unpaid_payroll']> {
    const records = await client.attendanceRecord.findMany({
      where: { employeeId: userId, deletedAt: null, clockOutServerTime: { not: null } },
      select: { branchId: true, clockInServerTime: true, branch: { select: { name: true } } },
    });
    if (records.length === 0) return [];
    const branchIds = [...new Set(records.map((r) => r.branchId))];
    const [policies, runs] = await Promise.all([
      client.payrollPolicy.findMany({ where: { branchId: { in: branchIds } }, select: { branchId: true, createdAt: true } }),
      client.payrollRun.findMany({
        where: { branchId: { in: branchIds }, status: 'finalized' },
        select: { branchId: true, periodStart: true, periodEnd: true },
      }),
    ]);
    const policyStart = new Map<string, number>();
    for (const policy of policies) {
      const at = policy.createdAt.getTime();
      policyStart.set(policy.branchId, Math.min(policyStart.get(policy.branchId) ?? at, at));
    }
    const isoDate = (value: Date) => value.toISOString().slice(0, 10);
    const unpaid = new Map<string, RemovalPrerequisites['unpaid_payroll'][number]>();
    for (const record of records) {
      const start = policyStart.get(record.branchId);
      if (start === undefined || record.clockInServerTime.getTime() < start) continue;
      const day = manilaDateKey(record.clockInServerTime);
      const paid = runs.some((run) => run.branchId === record.branchId && isoDate(run.periodStart) <= day && day <= isoDate(run.periodEnd));
      if (paid) continue;
      const entry = unpaid.get(record.branchId);
      if (!entry) {
        unpaid.set(record.branchId, { branch_id: record.branchId, branch_name: record.branch.name, first_date: day, last_date: day, records: 1 });
      } else {
        entry.records += 1;
        if (day < entry.first_date) entry.first_date = day;
        if (day > entry.last_date) entry.last_date = day;
      }
    }
    return [...unpaid.values()];
  },

  /** POS-PERF-P66 — the attribution record of an account (still present after the account itself is deleted). */
  findPerson(userId: string) {
    return prisma.person.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, role: true, accountDeletedAt: true, accountDeletedBy: true },
    });
  },

  /**
   * POS-PERF-P66 — permanent deletion of an account. One transaction:
   * 1. The first write takes the users row lock and only matches the version
   *    the person confirmed (a concurrent edit makes it 'changed').
   * 2. Prerequisites are re-checked under the lock; any blocker rolls back.
   * 3. Notifications and expense idempotency keys (plain user ids) go; a
   *    removed-account marker ends every already-issued access token; the
   *    attribution record is marked deleted (its id can never be reused).
   * 4. The users row is deleted. Its sessions, reset tokens, device PINs,
   *    staff PIN, branch access and notification preferences cascade with it.
   * History references Person, so no sale, shift, attendance record,
   * expense, payroll line, stock movement, proof or audit entry changes.
   */
  async deletePermanently(
    userId: string,
    deletedBy: string,
    expectedVersion: Date,
    role: string,
  ): Promise<
    | { outcome: 'deleted'; prerequisites: RemovalPrerequisites }
    | { outcome: 'not_found' }
    | { outcome: 'changed' }
    | { outcome: 'blocked'; prerequisites: RemovalPrerequisites }
  > {
    const now = new Date();
    try {
      return await prisma.$transaction(
        async (tx) => {
          const locked = await tx.user.updateMany({ where: { id: userId, updatedAt: expectedVersion }, data: { isActive: false } });
          if (locked.count === 0) {
            const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
            return { outcome: exists ? ('changed' as const) : ('not_found' as const) };
          }

          const prerequisites = await employeesRepository.getRemovalPrerequisites(userId, tx, role);
          if (hasBlockingPrerequisites(prerequisites)) throw new RemovalBlocked(prerequisites);

          await tx.notification.deleteMany({ where: { recipientUserId: userId } });
          await tx.expenseIdempotencyKey.deleteMany({ where: { userId } });
          const markerHash = removedAccountRevocationHash(userId);
          const markerExpiry = new Date(now.getTime() + REMOVED_ACCOUNT_MARKER_TTL_MS);
          await tx.revokedToken.upsert({
            where: { tokenHash: markerHash },
            create: { tokenHash: markerHash, expiresAt: markerExpiry },
            update: { expiresAt: markerExpiry },
          });
          await tx.person.update({ where: { id: userId }, data: { accountDeletedAt: now, accountDeletedBy: deletedBy } });
          await tx.user.delete({ where: { id: userId } });
          return { outcome: 'deleted' as const, prerequisites };
        },
        // The prerequisite reads run on one connection; leave room on a remote pooler.
        { maxWait: 10_000, timeout: 30_000 },
      );
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
