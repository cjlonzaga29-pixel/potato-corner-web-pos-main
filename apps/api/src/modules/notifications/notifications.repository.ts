import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateNotificationData } from './notifications.types.js';

/**
 * Notifications repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const notificationsRepository = {
  create(data: CreateNotificationData) {
    return prisma.notification.create({
      data: {
        type: data.type,
        payload: data.payload as unknown as Prisma.InputJsonValue,
        recipientUserId: data.recipientUserId,
        branchId: data.branchId,
      },
    });
  },

  /**
   * No existing super-admin-user-ids lookup was found anywhere in the
   * codebase (notifySuperAdmin broadcasts by socket room, not DB query).
   * Queries prisma.user directly here rather than through employeesRepository
   * — same precedent as fraudRepository.findEmployeeNamesByIds, which does
   * the same for its own cross-cutting User lookup. email is selected
   * alongside id (Task 10) because this is the only recipient-resolution
   * path for the 3 email-eligible notification types (fraud_alert_created,
   * large_adjustment_approval_needed, eod_summary) — Resend sends to
   * user.email in the DB, per the plan's locked recipient source.
   */
  findSuperAdminUserIds() {
    return prisma.user.findMany({
      where: { role: 'super_admin', isActive: true },
      select: { id: true, email: true },
    });
  },

  /**
   * Super admins (company-wide) plus supervisors assigned to the given
   * branch — matches the low_stock_alert/notifyBranch+notifySuperAdmin
   * recipient shape. email is selected alongside id (Phase 20 Task 5)
   * because large_adjustment_approval_needed emails this recipient set,
   * same reasoning as findSuperAdminUserIds above.
   */
  findBranchSupervisorAndAdminUserIds(branchId: string) {
    return prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ role: 'super_admin' }, { role: 'supervisor', branchAssignments: { some: { branchId, removedAt: null } } }],
      },
      select: { id: true, email: true },
    });
  },

  /** Supervisors assigned to the given branch only — no super admins (void_requested, offline_transactions_synced). */
  findBranchSupervisorUserIds(branchId: string) {
    return prisma.user.findMany({
      where: { isActive: true, role: 'supervisor', branchAssignments: { some: { branchId, removedAt: null } } },
      select: { id: true },
    });
  },

  /**
   * Task 220 — super admins (company-wide) + supervisors assigned to the
   * branch + the branch's own `branch`-role account. None of the three
   * helpers above ever included role: 'branch', so branch accounts had no
   * notification recipient path at all before this task. Used for the new
   * operational-visibility event types (sale/refund/expense/receiving/waste/
   * transfer/discount-compliance) where a branch account needs to see its
   * own branch's activity per the role-scoping requirement. A `branch`-role
   * user is resolved via UserBranchAssignment exactly like supervisor is —
   * confirmed against branches.service.ts's branch-account provisioning,
   * which creates one UserBranchAssignment row per branch account.
   */
  findBranchAllRolesUserIds(branchId: string) {
    return prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { role: 'super_admin' },
          { role: 'supervisor', branchAssignments: { some: { branchId, removedAt: null } } },
          { role: 'branch', branchAssignments: { some: { branchId, removedAt: null } } },
        ],
      },
      select: { id: true },
    });
  },

  /** GET /api/notifications — unread (readAt null) first, then newest first within each group. */
  async findForRecipient(recipientUserId: string, pagination: { page: number; limit: number }) {
    const where: Prisma.NotificationWhereInput = { recipientUserId };
    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { recipientUserId, readAt: null } }),
    ]);
    return { notifications, total, unreadCount };
  },

  /** Scoped to recipientUserId so one user can never mark another user's notification read — returns the affected row count (0 = not found or not owned). */
  markRead(id: string, recipientUserId: string) {
    return prisma.notification.updateMany({
      where: { id, recipientUserId },
      data: { readAt: new Date() },
    });
  },

  markAllRead(recipientUserId: string) {
    return prisma.notification.updateMany({
      where: { recipientUserId, readAt: null },
      data: { readAt: new Date() },
    });
  },

  /** Task 220 — Notification.branchId has no declared Prisma relation, so branch names are batch-joined manually at read time (never at write time, to keep every checkout/write-path call site above free of an extra query). */
  findBranchNames(branchIds: string[]) {
    if (branchIds.length === 0) return Promise.resolve([]);
    return prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } });
  },
};
