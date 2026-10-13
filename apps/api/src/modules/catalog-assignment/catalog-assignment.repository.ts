import type { CatalogResourceType } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';

/**
 * POS-PERF-P36 — the manual assignment *write* path (previously
 * findOwnership/casUpdateManagedBy/countDependents/findEligibleSupervisor/
 * createAssignmentRecord/findUserLabel/listUnmanaged) is retired: catalog
 * authority is now derived live from a supervisor's active branch
 * assignments (see catalog-authority.ts), not granted one resource at a time
 * by a Super Admin. Only the append-only audit read survives, since the
 * historical CatalogManagementAssignment rows created by POS-PERF-P35R must
 * stay available for internal audit — see docs/decisions/POS-PERF-P36-
 * branch-catalog-and-builder.md.
 */
async function listAssignmentHistory(resourceType: CatalogResourceType, resourceId: string) {
  return prisma.catalogManagementAssignment.findMany({
    where: { resourceType, resourceId },
    orderBy: { createdAt: 'desc' },
  });
}

export const catalogAssignmentRepository = {
  listAssignmentHistory,
};
