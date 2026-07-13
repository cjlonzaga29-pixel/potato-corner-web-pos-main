import { prisma } from '../../lib/prisma.js';

/**
 * Cash repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const cashRepository = {
  /** Read-only lookup used by the shift-guard middleware (Phase 2 RBAC). */
  findActiveShift(cashierId: string, branchId: string) {
    return prisma.shift.findFirst({
      where: { cashierId, branchId, status: 'active' },
    });
  },

  // TODO(Phase 1+): implement remaining queries for the cash module.
};
