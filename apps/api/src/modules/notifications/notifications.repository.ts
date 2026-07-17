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
   * the same for its own cross-cutting User lookup.
   */
  findSuperAdminUserIds() {
    return prisma.user.findMany({
      where: { role: 'super_admin', isActive: true },
      select: { id: true },
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
};
