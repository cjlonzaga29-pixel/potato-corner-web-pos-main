import { catalogAssignmentRepository as repo } from './catalog-assignment.repository.js';
import type { CatalogResourceType } from '@potato-corner/shared';

function toAssignmentResponse(row: {
  id: string;
  resourceType: string;
  resourceId: string;
  previousManagedBy: string | null;
  newManagedBy: string;
  assignedBy: string;
  reason: string;
  branchId: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    previous_managed_by: row.previousManagedBy,
    new_managed_by: row.newManagedBy,
    assigned_by: row.assignedBy,
    reason: row.reason,
    branch_id: row.branchId,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * POS-PERF-P36 — read-only internal audit trail of the POS-PERF-P35R manual
 * assignment era. No write path exists anymore; see catalog-assignment.
 * repository.ts's module doc.
 */
async function listHistory(resourceType: CatalogResourceType, resourceId: string) {
  const rows = await repo.listAssignmentHistory(resourceType, resourceId);
  return rows.map(toAssignmentResponse);
}

export const catalogAssignmentService = {
  listHistory,
};
