import { describe, it, expect, vi, beforeEach } from 'vitest';

// POS-PERF-P36 — the create/preview/unmanaged write-path tests this file
// used to hold are retired along with that surface (see catalog-assignment.
// repository.ts's module doc). Only the read-only audit history remains.
vi.mock('./catalog-assignment.repository.js', () => ({
  catalogAssignmentRepository: {
    listAssignmentHistory: vi.fn(),
  },
}));

const { catalogAssignmentRepository: repo } = await import('./catalog-assignment.repository.js');
const { catalogAssignmentService } = await import('./catalog-assignment.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('catalogAssignmentService.listHistory', () => {
  it('maps CatalogManagementAssignment rows to the snake_case history response shape', async () => {
    vi.mocked(repo.listAssignmentHistory).mockResolvedValue([
      {
        id: 'assign-1',
        resourceType: 'INVENTORY_CATEGORY',
        resourceId: 'cat-1',
        previousManagedBy: null,
        newManagedBy: 'sup-1',
        assignedBy: 'admin-1',
        reason: 'Pre-existing shared master data needed an owner before POS-PERF-P36',
        branchId: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ] as never);

    const history = await catalogAssignmentService.listHistory('INVENTORY_CATEGORY', 'cat-1');

    expect(repo.listAssignmentHistory).toHaveBeenCalledWith('INVENTORY_CATEGORY', 'cat-1');
    expect(history).toEqual([
      {
        id: 'assign-1',
        resource_type: 'INVENTORY_CATEGORY',
        resource_id: 'cat-1',
        previous_managed_by: null,
        new_managed_by: 'sup-1',
        assigned_by: 'admin-1',
        reason: 'Pre-existing shared master data needed an owner before POS-PERF-P36',
        branch_id: null,
        created_at: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });

  it('returns an empty history list for a resource with no prior assignment', async () => {
    vi.mocked(repo.listAssignmentHistory).mockResolvedValue([]);

    const history = await catalogAssignmentService.listHistory('PRODUCT', 'prod-1');

    expect(history).toEqual([]);
  });
});
