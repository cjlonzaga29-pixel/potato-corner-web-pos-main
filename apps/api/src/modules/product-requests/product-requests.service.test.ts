import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES, createProductRequestSchema } from '@potato-corner/shared';

vi.mock('./product-requests.repository.js', () => ({
  productRequestsRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: {
    createWithCascade: vi.fn(),
    createVariant: vi.fn(),
    findVariantById: vi.fn(),
  },
}));

vi.mock('../flavors/flavors.repository.js', () => ({
  flavorsRepository: {
    findByName: vi.fn(),
    create: vi.fn(),
    findVariantFlavorLink: vi.fn(),
    linkVariantFlavor: vi.fn(),
  },
}));

vi.mock('../recipes/recipes.repository.js', () => ({
  recipesRepository: {
    createRecipe: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
  notifyBranch: vi.fn(),
}));

const { productRequestsRepository } = await import('./product-requests.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { productRequestsService } = await import('./product-requests.service.js');
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
    proposedName: 'Curly Fries',
    proposedDescription: null,
    proposedCategory: 'Fries',
    proposedVariants: [{ name: 'Regular', size_label: 'Regular', base_price: 65 }],
    proposedFlavors: [],
    proposedRecipes: [],
    requestReason: 'Customers at our branch keep asking for curly fries specifically.',
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    createdProductId: null,
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

describe('createProductRequestSchema (schema-level)', () => {
  it('rejects a request_reason under 30 characters', () => {
    const result = createProductRequestSchema.safeParse({
      branch_id: '11111111-1111-4111-8111-111111111111',
      proposed_name: 'Curly Fries',
      proposed_variants: [{ name: 'Regular', size_label: 'Regular', base_price: 65 }],
      request_reason: 'Too short',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a request_reason of 30+ characters', () => {
    const result = createProductRequestSchema.safeParse({
      branch_id: '11111111-1111-4111-8111-111111111111',
      proposed_name: 'Curly Fries',
      proposed_variants: [{ name: 'Regular', size_label: 'Regular', base_price: 65 }],
      request_reason: 'Customers at our branch keep asking for curly fries.',
    });
    expect(result.success).toBe(true);
  });
});

describe('productRequestsService.submitRequest', () => {
  it('supervisor can submit a product request for their own branch', async () => {
    vi.mocked(productRequestsRepository.create).mockResolvedValue(buildRequestRow() as never);

    const result = await productRequestsService.submitRequest(
      {
        branch_id: 'branch-a',
        proposed_name: 'Curly Fries',
        proposed_variants: [{ name: 'Regular', size_label: 'Regular', base_price: 65 }],
        proposed_flavors: [],
        proposed_recipes: [],
        request_reason: 'Customers at our branch keep asking for curly fries specifically.',
      },
      SUPERVISOR_JWT,
      null,
    );

    expect(result.status).toBe('pending');
    expect(productRequestsRepository.create).toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_REQUEST_SUBMITTED' }));
    expect(notifySuperAdmin).toHaveBeenCalled();
  });

  it('rejects a supervisor submitting for a branch they are not assigned to', async () => {
    await expect(
      productRequestsService.submitRequest(
        {
          branch_id: 'branch-z',
          proposed_name: 'Curly Fries',
          proposed_variants: [{ name: 'Regular', size_label: 'Regular', base_price: 65 }],
          proposed_flavors: [],
          proposed_recipes: [],
          request_reason: 'Customers at our branch keep asking for curly fries specifically.',
        },
        SUPERVISOR_JWT,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });

    expect(productRequestsRepository.create).not.toHaveBeenCalled();
  });
});

describe('productRequestsService.listRequests', () => {
  it('super_admin sees all requests (no branch scoping applied)', async () => {
    vi.mocked(productRequestsRepository.findAll).mockResolvedValue({ requests: [buildRequestRow()], total: 1 } as never);

    const adminJwt = { user_id: 'admin-1', role: ROLES.SUPER_ADMIN as typeof ROLES.SUPER_ADMIN, email: 'a@test.com', iat: 0, exp: 0 };
    await productRequestsService.listRequests(adminJwt, { page: 1, limit: 25, branch_id: 'branch-z' });

    // super_admin's filters pass through untouched — unlike the supervisor
    // case below, branch_id is never forced/rewritten.
    expect(productRequestsRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-z' }));
  });

  it('supervisor is scoped to their own branch regardless of query filters', async () => {
    vi.mocked(productRequestsRepository.findAll).mockResolvedValue({ requests: [buildRequestRow()], total: 1 } as never);

    await productRequestsService.listRequests(SUPERVISOR_JWT, { page: 1, limit: 25, branch_id: 'branch-z' });

    expect(productRequestsRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-a' }));
  });
});

describe('productRequestsService.reviewRequest', () => {
  it('rejects a request with review notes', async () => {
    vi.mocked(productRequestsRepository.findById).mockResolvedValue(buildRequestRow() as never);
    vi.mocked(productRequestsRepository.updateStatus).mockResolvedValue(buildRequestRow({ status: 'rejected', reviewNotes: 'Not aligned with regional menu strategy.' }) as never);

    const result = await productRequestsService.reviewRequest(
      'req-1',
      { action: 'reject', review_notes: 'Not aligned with regional menu strategy.' },
      SUPER_ADMIN,
      null,
    );

    expect(result.status).toBe('rejected');
    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_REQUEST_REJECTED' }));
  });

  it('approves a request and creates the product with branch_exclusive true, scoped to the requesting branch', async () => {
    vi.mocked(productRequestsRepository.findById).mockResolvedValue(buildRequestRow() as never);
    vi.mocked(productsRepository.createWithCascade).mockResolvedValue({
      product: { id: 'prod-new' },
      cascadedBranchIds: ['branch-a'],
    } as never);
    vi.mocked(productsRepository.createVariant).mockResolvedValue({ id: 'variant-new' } as never);
    vi.mocked(productRequestsRepository.updateStatus).mockResolvedValue(
      buildRequestRow({ status: 'approved', createdProductId: 'prod-new' }) as never,
    );

    const result = await productRequestsService.reviewRequest('req-1', { action: 'approve' }, SUPER_ADMIN, null);

    expect(productsRepository.createWithCascade).toHaveBeenCalledWith(
      expect.objectContaining({ branchExclusive: true, exclusiveBranchId: 'branch-a' }),
      SUPER_ADMIN.id,
    );
    expect(productsRepository.createWithCascade).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      SUPER_ADMIN.id,
    );
    expect(result.created_product_id).toBe('prod-new');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_REQUEST_APPROVED' }));
  });

  it('rejects reviewing a request that has already been reviewed', async () => {
    vi.mocked(productRequestsRepository.findById).mockResolvedValue(buildRequestRow({ status: 'approved' }) as never);

    await expect(productRequestsService.reviewRequest('req-1', { action: 'approve' }, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'PRODUCT_REQUEST_ALREADY_REVIEWED',
      statusCode: 409,
    });
  });
});
