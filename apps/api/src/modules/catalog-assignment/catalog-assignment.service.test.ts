import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./catalog-assignment.repository.js', () => ({
  catalogAssignmentRepository: {
    findOwnership: vi.fn(),
    casUpdateManagedBy: vi.fn(),
    countDependents: vi.fn(),
    findEligibleSupervisor: vi.fn(),
    createAssignmentRecord: vi.fn(),
    findUserLabel: vi.fn(),
    listAssignmentHistory: vi.fn(),
  },
}));

vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { catalogAssignmentRepository: repo } = await import('./catalog-assignment.repository.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { catalogAssignmentService } = await import('./catalog-assignment.service.js');

const SUPER_ADMIN = { id: 'admin-1', role: 'super_admin' };

function ownershipRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    exists: true,
    createdBy: null,
    managedBy: null,
    label: 'Inventory Category A',
    exclusiveBranchId: null,
    ...overrides,
  };
}

function supervisorRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sup-1',
    role: 'supervisor',
    isActive: true,
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('catalogAssignmentService.createAssignment', () => {
  const input = {
    resource_type: 'INVENTORY_CATEGORY' as const,
    resource_id: 'cat-1',
    supervisor_id: 'sup-1',
    reason: 'Pre-existing shared master data needs an owner for Phase 20 recipe setup',
  };

  it('rejects when the target resource does not exist', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue({ exists: false, createdBy: null, managedBy: null, label: '', exclusiveBranchId: null });

    await expect(catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(repo.casUpdateManagedBy).not.toHaveBeenCalled();
  });

  it('rejects when the supervisor_id does not resolve to a user', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow());
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(null);

    await expect(catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null)).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_FOUND' });
  });

  it('rejects a target user who is not role=supervisor (no privilege widening via assignment)', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow());
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow({ role: 'super_admin' }));

    await expect(catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null)).rejects.toMatchObject({ code: 'SUPERVISOR_INVALID_ROLE' });
  });

  it('rejects an inactive/deactivated supervisor', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow());
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow({ isActive: false }));

    await expect(catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null)).rejects.toMatchObject({ code: 'SUPERVISOR_INACTIVE' });
  });

  it('rejects assigning a branch-exclusive product to a supervisor with no active assignment to that branch', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow({ exclusiveBranchId: 'branch-9' }));
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow());
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);

    await expect(
      catalogAssignmentService.createAssignment({ ...input, resource_type: 'PRODUCT' }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'SUPERVISOR_BRANCH_SCOPE_INVALID' });
    expect(repo.casUpdateManagedBy).not.toHaveBeenCalled();
  });

  it('rejects naming the assigning Super Admin themselves as the new manager — they are not a supervisor account', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow());
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow({ id: SUPER_ADMIN.id, role: 'super_admin' }));

    await expect(catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null)).rejects.toMatchObject({ code: 'SUPERVISOR_INVALID_ROLE' });
  });

  it('surfaces a conflict (never silently overwrites) when the CAS loses a concurrent assignment race', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow());
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow());
    vi.mocked(repo.casUpdateManagedBy).mockResolvedValue(false);

    await expect(catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null)).rejects.toMatchObject({ code: 'ASSIGNMENT_CONFLICT' });
    expect(repo.createAssignmentRecord).not.toHaveBeenCalled();
  });

  it('assigns a NULL-owned (orphaned shared) record and writes an audit row with previous_managed_by: null', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow({ managedBy: null }));
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow());
    vi.mocked(repo.casUpdateManagedBy).mockResolvedValue(true);
    vi.mocked(repo.createAssignmentRecord).mockResolvedValue({
      id: 'assign-1',
      resourceType: 'INVENTORY_CATEGORY',
      resourceId: 'cat-1',
      previousManagedBy: null,
      newManagedBy: 'sup-1',
      assignedBy: 'admin-1',
      reason: input.reason,
      branchId: null,
      createdAt: new Date('2026-10-13'),
    } as never);

    const result = await catalogAssignmentService.createAssignment(input, SUPER_ADMIN, '127.0.0.1');

    expect(repo.casUpdateManagedBy).toHaveBeenCalledWith('INVENTORY_CATEGORY', 'cat-1', null, 'sup-1');
    expect(result).toMatchObject({ previous_managed_by: null, new_managed_by: 'sup-1', resource_id: 'cat-1' });
  });

  it('reassigns a record already managed by a different supervisor, preserving the prior manager in previous_managed_by', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow({ managedBy: 'sup-old' }));
    vi.mocked(repo.findEligibleSupervisor).mockResolvedValue(supervisorRow());
    vi.mocked(repo.casUpdateManagedBy).mockResolvedValue(true);
    vi.mocked(repo.createAssignmentRecord).mockResolvedValue({
      id: 'assign-2',
      resourceType: 'INVENTORY_CATEGORY',
      resourceId: 'cat-1',
      previousManagedBy: 'sup-old',
      newManagedBy: 'sup-1',
      assignedBy: 'admin-1',
      reason: input.reason,
      branchId: null,
      createdAt: new Date('2026-10-13'),
    } as never);

    const result = await catalogAssignmentService.createAssignment(input, SUPER_ADMIN, null);

    expect(repo.casUpdateManagedBy).toHaveBeenCalledWith('INVENTORY_CATEGORY', 'cat-1', 'sup-old', 'sup-1');
    expect(result.previous_managed_by).toBe('sup-old');
  });
});

describe('catalogAssignmentService.previewAssignment', () => {
  it('rejects previewing a resource that does not exist', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue({ exists: false, createdBy: null, managedBy: null, label: '', exclusiveBranchId: null });

    await expect(catalogAssignmentService.previewAssignment('PRODUCT_CATEGORY', 'missing')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('reports the dependent-record summary and eligible branch scope without writing anything', async () => {
    vi.mocked(repo.findOwnership).mockResolvedValue(ownershipRow({ exclusiveBranchId: 'branch-9' }));
    vi.mocked(repo.findUserLabel).mockResolvedValue(null);
    vi.mocked(repo.countDependents).mockResolvedValue([{ resourceType: 'PRODUCT', count: 3, distinctOtherManagers: 2 }]);

    const preview = await catalogAssignmentService.previewAssignment('PRODUCT_CATEGORY', 'cat-1');

    expect(preview.eligible_branch_ids).toEqual(['branch-9']);
    expect(preview.dependent_summary).toEqual([{ resource_type: 'PRODUCT', count: 3, distinct_other_managers: 2 }]);
    expect(repo.casUpdateManagedBy).not.toHaveBeenCalled();
  });
});
