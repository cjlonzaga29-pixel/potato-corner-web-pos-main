import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES, createPriceOverrideSchema } from '@potato-corner/shared';

vi.mock('./price-overrides.repository.js', () => ({
  priceOverridesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findPendingForVariant: vi.fn(),
    findActiveOverride: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
  notifyBranch: vi.fn(),
}));

const { priceOverridesRepository } = await import('./price-overrides.repository.js');
const { priceOverridesService } = await import('./price-overrides.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const SUPER_ADMIN = { id: 'admin-1', role: ROLES.SUPER_ADMIN };

const BRANCH_JWT = {
  user_id: 'branch-1',
  role: ROLES.BRANCH as typeof ROLES.BRANCH,
  email: 'branch@test.com',
  branch_ids: ['branch-a'],
  iat: 0,
  exp: 0,
};

function buildOverrideRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'override-1',
    branchId: 'branch-a',
    productVariantId: 'variant-1',
    requestedPrice: { toNumber: () => 75 },
    status: 'pending',
    requestedBy: 'sup-1',
    requestReason: 'Higher ingredient costs at this branch justify the price increase.',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    effectiveFrom: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    branch: { id: 'branch-a', name: 'Main' },
    productVariant: { id: 'variant-1', name: 'Regular', basePrice: { toNumber: () => 65 }, product: { name: 'Cheese Fries' } },
    requester: { id: 'sup-1', firstName: 'Sup', lastName: 'Visor' },
    reviewer: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createPriceOverrideSchema (schema-level)', () => {
  it('rejects a request_reason under 20 characters', () => {
    const result = createPriceOverrideSchema.safeParse({
      branch_id: '11111111-1111-4111-8111-111111111111',
      product_variant_id: '22222222-2222-4222-8222-222222222222',
      requested_price: 75,
      request_reason: 'Too short',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a request_reason of 20+ characters', () => {
    const result = createPriceOverrideSchema.safeParse({
      branch_id: '11111111-1111-4111-8111-111111111111',
      product_variant_id: '22222222-2222-4222-8222-222222222222',
      requested_price: 75,
      request_reason: 'Higher ingredient costs at this branch.',
    });
    expect(result.success).toBe(true);
  });
});

describe('priceOverridesService.submitOverrideRequest', () => {
  it('branch account can submit a valid price override request', async () => {
    vi.mocked(priceOverridesRepository.findPendingForVariant).mockResolvedValue(null);
    vi.mocked(priceOverridesRepository.create).mockResolvedValue(buildOverrideRow() as never);

    const result = await priceOverridesService.submitOverrideRequest(
      {
        branch_id: 'branch-a',
        product_variant_id: 'variant-1',
        requested_price: 75,
        request_reason: 'Higher ingredient costs at this branch justify the price increase.',
      },
      BRANCH_JWT,
      null,
    );

    expect(result.status).toBe('pending');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRICE_OVERRIDE_SUBMITTED' }));
  });

  it('rejects a duplicate pending request for the same branch and variant', async () => {
    vi.mocked(priceOverridesRepository.findPendingForVariant).mockResolvedValue(buildOverrideRow() as never);

    await expect(
      priceOverridesService.submitOverrideRequest(
        {
          branch_id: 'branch-a',
          product_variant_id: 'variant-1',
          requested_price: 80,
          request_reason: 'Another reason for the same variant at this branch.',
        },
        BRANCH_JWT,
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRICE_OVERRIDE_ALREADY_PENDING', statusCode: 409 });

    expect(priceOverridesRepository.create).not.toHaveBeenCalled();
  });

  it('rejects a branch account submitting for a branch they are not assigned to', async () => {
    await expect(
      priceOverridesService.submitOverrideRequest(
        {
          branch_id: 'branch-z',
          product_variant_id: 'variant-1',
          requested_price: 75,
          request_reason: 'Higher ingredient costs at this branch justify the price increase.',
        },
        BRANCH_JWT,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });
  });
});

describe('priceOverridesService.reviewOverride', () => {
  it('approving sets status approved and effective_from', async () => {
    vi.mocked(priceOverridesRepository.findById).mockResolvedValue(buildOverrideRow() as never);
    vi.mocked(priceOverridesRepository.updateStatus).mockResolvedValue(buildOverrideRow({ status: 'approved' }) as never);

    const result = await priceOverridesService.reviewOverride('override-1', { action: 'approve' }, SUPER_ADMIN, null);

    expect(result.status).toBe('approved');
    expect(priceOverridesRepository.updateStatus).toHaveBeenCalledWith(
      'override-1',
      expect.objectContaining({ status: 'approved', effectiveFrom: expect.any(Date) }),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRICE_OVERRIDE_APPROVED' }));
  });

  it('rejecting does not set effective_from', async () => {
    vi.mocked(priceOverridesRepository.findById).mockResolvedValue(buildOverrideRow() as never);
    vi.mocked(priceOverridesRepository.updateStatus).mockResolvedValue(buildOverrideRow({ status: 'rejected' }) as never);

    await priceOverridesService.reviewOverride(
      'override-1',
      { action: 'reject', review_notes: 'Margin would drop below the branch minimum threshold.' },
      SUPER_ADMIN,
      null,
    );

    expect(priceOverridesRepository.updateStatus).toHaveBeenCalledWith(
      'override-1',
      expect.objectContaining({ status: 'rejected', effectiveFrom: undefined }),
    );
  });
});

describe('priceOverridesService.getActivePriceForBranch', () => {
  it('returns the override price when an approved override exists', async () => {
    vi.mocked(priceOverridesRepository.findActiveOverride).mockResolvedValue({
      requestedPrice: { toNumber: () => 75 },
    } as never);

    const price = await priceOverridesService.getActivePriceForBranch('branch-a', 'variant-1', 65);

    expect(price).toBe(75);
  });

  it('returns the master price when no override is active', async () => {
    vi.mocked(priceOverridesRepository.findActiveOverride).mockResolvedValue(null);

    const price = await priceOverridesService.getActivePriceForBranch('branch-a', 'variant-1', 65);

    expect(price).toBe(65);
  });

  it('a rejected override does not affect pricing (repository only queries approved rows)', async () => {
    // findActiveOverride's own query filters status: 'approved' — a rejected-only
    // history resolves to null here, which is exactly what this asserts.
    vi.mocked(priceOverridesRepository.findActiveOverride).mockResolvedValue(null);

    const price = await priceOverridesService.getActivePriceForBranch('branch-a', 'variant-1', 65);

    expect(price).toBe(65);
  });
});
