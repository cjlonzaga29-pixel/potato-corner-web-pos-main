import type { Prisma, EmployeeStatus as PrismaEmployeeStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { nextCounterValue } from '../../lib/id-counter.js';
import type { CreateEmployeeData, EmployeeActivityData, EmployeeListFilters, UpdateEmployeeData } from './employees.types.js';

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
  const and: Prisma.UserWhereInput[] = [];

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

  return and.length > 0 ? { AND: and } : {};
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
    return prisma.user.findUnique({ where: { id }, select: { status: true, isActive: true } });
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
      where: { isActive: true, branchAssignments: { some: { branchId: { in: branchIds }, removedAt: null } } },
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

  create(data: CreateEmployeeData) {
    return prisma.$transaction(async (tx) => {
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
    });
  },

  update(id: string, data: UpdateEmployeeData) {
    return prisma.user.update({ where: { id }, data, select: employeeSelect });
  },

  deactivate(id: string, deactivatedBy: string, reason: string) {
    return prisma.user.update({
      where: { id },
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
      where: { id },
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
      where: { id },
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

  async hasActiveShift(userId: string): Promise<boolean> {
    const count = await prisma.shift.count({ where: { cashierId: userId, status: 'active' } });
    return count > 0;
  },

  async getActivity(employeeId: string): Promise<EmployeeActivityData> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

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
