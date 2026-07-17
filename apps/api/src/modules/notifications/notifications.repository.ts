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

  /** Super admins (company-wide) plus supervisors assigned to the given branch — matches the low_stock_alert/notifyBranch+notifySuperAdmin recipient shape. */
  findBranchSupervisorAndAdminUserIds(branchId: string) {
    return prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ role: 'super_admin' }, { role: 'supervisor', branchAssignments: { some: { branchId, removedAt: null } } }],
      },
      select: { id: true },
    });
  },

  /** Supervisors assigned to the given branch only — no super admins (void_requested, offline_transactions_synced). */
  findBranchSupervisorUserIds(branchId: string) {
    return prisma.user.findMany({
      where: { isActive: true, role: 'supervisor', branchAssignments: { some: { branchId, removedAt: null } } },
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
};
