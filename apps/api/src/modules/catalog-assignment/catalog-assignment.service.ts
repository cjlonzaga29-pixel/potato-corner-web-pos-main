import { ROLES } from '@potato-corner/shared';
import { catalogAssignmentRepository as repo } from './catalog-assignment.repository.js';
import { CatalogAssignmentError, type CreateCatalogAssignmentInput } from './catalog-assignment.types.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

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
 * Validates everything the create path also validates, but performs no
 * write — the "read-only impact preview" the assignment UI calls before
 * the Super Admin confirms. Surfaces the current state plus how many other
 * records (and distinct other managers) depend on this one, so a Super
 * Admin can see the shared-reference blast radius before committing.
 */
async function previewAssignment(resourceType: CreateCatalogAssignmentInput['resource_type'], resourceId: string) {
  const resource = await repo.findOwnership(resourceType, resourceId);
  if (!resource.exists) {
    throw new CatalogAssignmentError('RESOURCE_NOT_FOUND', 'The selected catalog resource does not exist', 404);
  }

  const [managerLabel, dependents] = await Promise.all([
    repo.findUserLabel(resource.managedBy ?? resource.createdBy),
    repo.countDependents(resourceType, resourceId),
  ]);

  const eligibleBranchIds = resource.exclusiveBranchId ? [resource.exclusiveBranchId] : null;

  return {
    resource_type: resourceType,
    resource_id: resourceId,
    resource_label: resource.label,
    current_created_by: resource.createdBy,
    current_managed_by: resource.managedBy,
    current_manager_label: managerLabel,
    dependent_summary: dependents.map((d) => ({
      resource_type: d.resourceType,
      count: d.count,
      distinct_other_managers: d.distinctOtherManagers,
    })),
    eligible_branch_ids: eligibleBranchIds,
  };
}

/**
 * POS-PERF-P35R — the one write path that may set managedBy. Deliberately
 * narrow: no bulk mode, no "assign every orphaned record of this type" —
 * every call names exactly one resource and one supervisor, with a reason,
 * so the audit trail stays one row per deliberate decision. No automatic
 * backfill to an arbitrary supervisor is possible through this path.
 */
async function createAssignment(input: CreateCatalogAssignmentInput, actor: ActorContext, ipAddress: string | null) {
  const resource = await repo.findOwnership(input.resource_type, input.resource_id);
  if (!resource.exists) {
    throw new CatalogAssignmentError('RESOURCE_NOT_FOUND', 'The selected catalog resource does not exist', 404);
  }

  const supervisor = await repo.findEligibleSupervisor(input.supervisor_id);
  if (!supervisor) {
    throw new CatalogAssignmentError('SUPERVISOR_NOT_FOUND', 'The selected supervisor does not exist', 404);
  }
  if (supervisor.role !== ROLES.SUPERVISOR) {
    throw new CatalogAssignmentError('SUPERVISOR_INVALID_ROLE', 'Management can only be assigned to a Supervisor account', 422);
  }
  if (!supervisor.isActive) {
    throw new CatalogAssignmentError('SUPERVISOR_INACTIVE', 'The selected supervisor account is not active', 422);
  }

  // Branch-agnostic catalog/inventory master data (categories, groups,
  // options, units, conversions, items — CR-007 §3) has no branch to scope
  // against. Only a branch-exclusive Product does; the assigned supervisor
  // must have an active assignment to that specific branch, otherwise the
  // assignment would hand them management of a product they have no
  // operational reach into.
  let branchId: string | null = null;
  if (resource.exclusiveBranchId) {
    branchId = resource.exclusiveBranchId;
    const activeBranchIds = await branchesRepository.findAllActiveBranchIds(input.supervisor_id);
    if (!activeBranchIds.includes(resource.exclusiveBranchId)) {
      throw new CatalogAssignmentError(
        'SUPERVISOR_BRANCH_SCOPE_INVALID',
        'The selected supervisor is not assigned to this product’s exclusive branch',
        422,
      );
    }
  }

  const swapped = await repo.casUpdateManagedBy(input.resource_type, input.resource_id, resource.managedBy, input.supervisor_id);
  if (!swapped) {
    throw new CatalogAssignmentError(
      'ASSIGNMENT_CONFLICT',
      'This resource’s management assignment changed while this request was in flight. Reload and try again.',
      409,
    );
  }

  const assignment = await repo.createAssignmentRecord({
    resourceType: input.resource_type,
    resourceId: input.resource_id,
    previousManagedBy: resource.managedBy,
    newManagedBy: input.supervisor_id,
    assignedBy: actor.id,
    reason: input.reason,
    branchId,
  });

  const response = toAssignmentResponse(assignment);

  await recordAuditLog({
    action: 'CATALOG_MANAGEMENT_ASSIGNED',
    entityType: 'catalog_management_assignment',
    entityId: assignment.id,
    actorId: actor.id,
    actorRole: actor.role,
    beforeState: { resource_type: input.resource_type, resource_id: input.resource_id, previous_managed_by: resource.managedBy },
    afterState: response,
    ipAddress,
  });

  return response;
}

async function listHistory(resourceType: CreateCatalogAssignmentInput['resource_type'], resourceId: string) {
  const rows = await repo.listAssignmentHistory(resourceType, resourceId);
  return rows.map(toAssignmentResponse);
}

/** Starting point for the assignment UI: records of this type with no explicit manager yet. */
async function listUnmanaged(resourceType: CreateCatalogAssignmentInput['resource_type'], page: number, limit: number) {
  const { rows, total } = await repo.listUnmanaged(resourceType, page, limit);
  return {
    resources: rows.map((r) => ({ id: r.id, label: r.label, created_by: r.createdBy })),
    total,
    page,
    limit,
  };
}

export const catalogAssignmentService = {
  previewAssignment,
  createAssignment,
  listHistory,
  listUnmanaged,
};
