import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES, createFlavorRequestSchema } from '@potato-corner/shared';

vi.mock('./flavor-requests.repository.js', () => ({
  flavorRequestsRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../flavors/flavors.repository.js', () => ({
  flavorsRepository: {
    findByName: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
  notifyBranch: vi.fn(),
}));

const { flavorRequestsRepository } = await import('./flavor-requests.repository.js');
const { flavorsRepository } = await import('../flavors/flavors.repository.js');
const { flavorRequestsService } = await import('./flavor-requests.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { notifySuperAdmin } = await import('../../lib/notify.js');

const SUPER_ADMIN = { id: 'admin-1', role: ROLES.SUPER_ADMIN };
const SUPERVISOR_JWT = {
  user_id: 'sup-1',
  role: ROLES.SUPERVISOR as typeof ROLES.SUPERVISOR,
  email: 'sup@test.com',
  branch_ids: ['branch-a'],
  iat: 0,
  exp: 0,
};

function buildRequestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'req-1',
    branchId: 'branch-a',
    requestedBy: 'sup-1',
    proposedName: 'Cheese Explosion',
    proposedDescription: null,
    proposedColorHex: '#FFD700',
    proposedDisplayOrder: null,
    requestReason: 'Customers at our branch keep asking for a cheesier flavor option.',
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    createdFlavorId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    branch: { id: 'branch-a', name: 'Main', code: 'PC-MNL-001' },
    requester: { id: 'sup-1', firstName: 'Sup', lastName: 'Visor' },
    reviewer: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createFlavorRequestSchema (schema-level)', () => {
  it('rejects a request_reason under 30 characters', () => {
    const result = createFlavorRequestSchema.safeParse({
      branch_id: '11111111-1111-4111-8111-111111111111',
      proposed_name: 'Cheese Explosion',
      proposed_color_hex: '#FFD700',
      request_reason: 'Too short',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a request_reason of 30+ characters', () => {
    const result = createFlavorRequestSchema.safeParse({
      branch_id: '11111111-1111-4111-8111-111111111111',
      proposed_name: 'Cheese Explosion',
      proposed_color_hex: '#FFD700',
      request_reason: 'Customers at our branch keep asking for this flavor.',
    });
    expect(result.success).toBe(true);
  });
});

describe('flavorRequestsService.submitRequest', () => {
  it('supervisor can submit a flavor request for their own branch', async () => {
    vi.mocked(flavorRequestsRepository.create).mockResolvedValue(buildRequestRow() as never);

    const result = await flavorRequestsService.submitRequest(
      {
        branch_id: 'branch-a',
        proposed_name: 'Cheese Explosion',
        proposed_color_hex: '#FFD700',
        request_reason: 'Customers at our branch keep asking for this flavor.',
      },
      SUPERVISOR_JWT,
      null,
    );

    expect(result.status).toBe('pending');
    expect(flavorRequestsRepository.create).toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FLAVOR_REQUEST_SUBMITTED' }));
    expect(notifySuperAdmin).toHaveBeenCalled();
  });

  it('rejects a non-supervisor submitting a flavor request', async () => {
    const adminJwt = { user_id: 'admin-1', role: ROLES.SUPER_ADMIN as typeof ROLES.SUPER_ADMIN, email: 'a@test.com', iat: 0, exp: 0 };
    await expect(
      flavorRequestsService.submitRequest(
        {
          branch_id: 'branch-a',
          proposed_name: 'Cheese Explosion',
          proposed_color_hex: '#FFD700',
          request_reason: 'Customers at our branch keep asking for this flavor.',
        },
        adminJwt,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });

    expect(flavorRequestsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects a supervisor submitting for a branch they are not assigned to', async () => {
    await expect(
      flavorRequestsService.submitRequest(
        {
          branch_id: 'branch-z',
          proposed_name: 'Cheese Explosion',
          proposed_color_hex: '#FFD700',
          request_reason: 'Customers at our branch keep asking for this flavor.',
        },
        SUPERVISOR_JWT,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });

    expect(flavorRequestsRepository.create).not.toHaveBeenCalled();
  });
});

describe('flavorRequestsService.listRequests', () => {
  it('super_admin sees all requests (no branch scoping applied)', async () => {
    vi.mocked(flavorRequestsRepository.findAll).mockResolvedValue({ requests: [buildRequestRow()], total: 1 } as never);

    const adminJwt = { user_id: 'admin-1', role: ROLES.SUPER_ADMIN as typeof ROLES.SUPER_ADMIN, email: 'a@test.com', iat: 0, exp: 0 };
    await flavorRequestsService.listRequests(adminJwt, { page: 1, limit: 25, branch_id: 'branch-z' });

    expect(flavorRequestsRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-z' }));
  });

  it('supervisor is scoped to their own branch regardless of query filters', async () => {
    vi.mocked(flavorRequestsRepository.findAll).mockResolvedValue({ requests: [buildRequestRow()], total: 1 } as never);

    await flavorRequestsService.listRequests(SUPERVISOR_JWT, { page: 1, limit: 25, branch_id: 'branch-z' });

    expect(flavorRequestsRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-a' }));
  });
});

describe('flavorRequestsService.reviewRequest', () => {
  it('rejects reviewing a request that does not exist', async () => {
    vi.mocked(flavorRequestsRepository.findById).mockResolvedValue(null as never);

    await expect(flavorRequestsService.reviewRequest('missing', { action: 'approve' }, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'FLAVOR_REQUEST_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('rejects reviewing a request that has already been reviewed', async () => {
    vi.mocked(flavorRequestsRepository.findById).mockResolvedValue(buildRequestRow({ status: 'approved' }) as never);

    await expect(flavorRequestsService.reviewRequest('req-1', { action: 'approve' }, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'FLAVOR_REQUEST_ALREADY_REVIEWED',
      statusCode: 409,
    });
  });

  it('rejects a request with review notes', async () => {
    vi.mocked(flavorRequestsRepository.findById).mockResolvedValue(buildRequestRow() as never);
    vi.mocked(flavorRequestsRepository.updateStatus).mockResolvedValue(
      buildRequestRow({ status: 'rejected', reviewNotes: 'Too similar to an existing flavor already on the menu.' }) as never,
    );

    const result = await flavorRequestsService.reviewRequest(
      'req-1',
      { action: 'reject', review_notes: 'Too similar to an existing flavor already on the menu.' },
      SUPER_ADMIN,
      null,
    );

    expect(result.status).toBe('rejected');
    expect(flavorsRepository.create).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FLAVOR_REQUEST_REJECTED' }));
  });

  it('approves a request and creates the flavor via flavorsRepository', async () => {
    vi.mocked(flavorRequestsRepository.findById).mockResolvedValue(buildRequestRow() as never);
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null as never);
    vi.mocked(flavorsRepository.create).mockResolvedValue({ id: 'flavor-new' } as never);
    vi.mocked(flavorRequestsRepository.updateStatus).mockResolvedValue(
      buildRequestRow({ status: 'approved', createdFlavorId: 'flavor-new' }) as never,
    );

    const result = await flavorRequestsService.reviewRequest('req-1', { action: 'approve' }, SUPER_ADMIN, null);

    expect(flavorsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Cheese Explosion', colorHex: '#FFD700', isActive: true }),
    );
    expect(result.created_flavor_id).toBe('flavor-new');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FLAVOR_REQUEST_APPROVED' }));
  });

  it('rejects approval with a name conflict against an existing flavor', async () => {
    vi.mocked(flavorRequestsRepository.findById).mockResolvedValue(buildRequestRow() as never);
    vi.mocked(flavorsRepository.findByName).mockResolvedValue({ id: 'existing-flavor', name: 'Cheese Explosion' } as never);

    await expect(flavorRequestsService.reviewRequest('req-1', { action: 'approve' }, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'FLAVOR_NAME_CONFLICT',
      statusCode: 409,
    });

    expect(flavorsRepository.create).not.toHaveBeenCalled();
    expect(flavorRequestsRepository.updateStatus).not.toHaveBeenCalled();
  });
});
