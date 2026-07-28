import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { ROLES, SOCKET_EVENTS } from '@potato-corner/shared';

vi.mock('./products.repository.js', () => ({
  productsRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    createWithCascade: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updateImage: vi.fn(),
    clearImage: vi.fn(),
    countActiveBranches: vi.fn(),
    createVariant: vi.fn(),
    updateVariant: vi.fn(),
    findVariantById: vi.fn(),
    upsertBranchProductAvailability: vi.fn(),
    // Default empty — notifyVariantBranches (CR-005 Sub-phase 3c) iterates
    // this on every lifecycle transition; only tests asserting branch-room
    // broadcasts need to override it.
    findBranchProductAvailability: vi.fn().mockResolvedValue([]),
    cascadeBranchAvailabilityOff: vi.fn(),
    getProductsByGlobalStatus: vi.fn(),
    allActiveBranches: vi.fn(),
    findActiveBranch: vi.fn(),
    deleteProductCascade: vi.fn(),
    deleteVariantCascade: vi.fn(),
    // CR-005 Sub-phase 3c
    updateVariantLifecycle: vi.fn(),
    insertVariantChangeLog: vi.fn(),
    countFlavorSlots: vi.fn(),
    // CR-005 Sub-phase 3d — flavor slot CRUD
    listVariantFlavorSlots: vi.fn().mockResolvedValue([]),
    findFlavorSlotById: vi.fn(),
    insertFlavorSlot: vi.fn(),
    updateFlavorSlot: vi.fn(),
    deleteFlavorSlot: vi.fn(),
    shiftFlavorSlotIndicesDown: vi.fn(),
    rewriteFlavorSlotOrder: vi.fn(),
    countVariantFlavorSlots: vi.fn().mockResolvedValue(0),
    // Phase 10 POS catalog
    findCatalogForBranch: vi.fn().mockResolvedValue([]),
    findDisabledFlavorIds: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../product-inventory/product-inventory.repository.js', () => ({
  productInventoryRepository: {
    hasMappingForVariant: vi.fn().mockResolvedValue(true),
    hasAnyActiveMappingForVariant: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
  notifyBranch: vi.fn(),
}));

// editActiveVariant/archiveVariant wrap variant-update + change-log-insert in
// prisma.$transaction; the repository calls inside that callback are mocked
// separately above, so the tx client itself is never touched — a stand-in
// object is enough, and $transaction just runs the callback immediately with
// it. Same pattern as branches.service.test.ts's CR-005 3b companion fix.
const { txMock } = vi.hoisted(() => ({ txMock: {} }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(txMock)) },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://cdn.test/product-images/img.webp' } })),
      })),
    },
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
  })),
}));

const { productsRepository } = await import('./products.repository.js');
const { productsService } = await import('./products.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { supabaseAdmin } = await import('../../lib/supabase.js');
const { notifySuperAdmin, notifyBranch } = await import('../../lib/notify.js');
const { productInventoryRepository } = await import('../product-inventory/product-inventory.repository.js');
const { prisma } = await import('../../lib/prisma.js');

function buildVariant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'variant-1',
    productId: 'prod-1',
    name: 'Regular',
    sizeLabel: 'Regular',
    basePrice: { toNumber: () => 65 },
    vatableCapAmount: null,
    displayOrder: null,
    isActive: true,
    kcal: null,
    maxFlavors: 1,
    lifecycleStatus: 'ACTIVE',
    version: 1,
    lastChangeReason: null,
    createdById: null,
    approvedById: null,
    approvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    variantFlavors: [],
    ...overrides,
  };
}

function buildFlavorSlot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'slot-1',
    productVariantId: 'variant-1',
    slotIndex: 0,
    label: 'Flavor A',
    flavorQty: { toNumber: () => 10 },
    unit: 'grams',
    required: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const SUPER_ADMIN = { id: 'admin-1', role: ROLES.SUPER_ADMIN };
const SUPERVISOR = { id: 'sup-1', role: ROLES.SUPERVISOR };
const BRANCH_ACTOR = { id: 'branch-acct-1', role: ROLES.BRANCH };

function buildProduct(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'prod-1',
    name: 'Cheese Fries',
    description: null,
    category: 'Fries',
    imageUrl: null,
    status: 'draft',
    displayOrder: null,
    isSeasonal: false,
    seasonalStartDate: null,
    seasonalEndDate: null,
    createdBy: 'admin-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    variants: [],
    branchAvailability: [],
    creator: null,
    branchExclusive: false,
    exclusiveBranchId: null,
    exclusiveBranch: null,
    ...overrides,
  };
}

/** createWithCascade's real return shape: { product, cascadedBranchIds }. */
function buildCreateResult(productOverrides: Partial<Record<string, unknown>> = {}, cascadedBranchIds: string[] = ['branch-a', 'branch-b']) {
  return { product: buildProduct(productOverrides), cascadedBranchIds };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productsService.createProduct', () => {
  it('succeeds with active status', async () => {
    vi.mocked(productsRepository.createWithCascade).mockResolvedValue(buildCreateResult({ status: 'active' }) as never);

    const result = await productsService.createProduct(
      { name: 'Cheese Fries', status: 'active', is_seasonal: false, branch_exclusive: false },
      SUPER_ADMIN,
      null,
    );

    expect(result.status).toBe('active');
    expect(productsRepository.createWithCascade).toHaveBeenCalled();
  });

  it('succeeds with draft status', async () => {
    vi.mocked(productsRepository.createWithCascade).mockResolvedValue(buildCreateResult({ status: 'draft' }) as never);

    const result = await productsService.createProduct(
      { name: 'Cheese Fries', status: 'draft', is_seasonal: false, branch_exclusive: false },
      SUPER_ADMIN,
      null,
    );

    expect(result.status).toBe('draft');
  });

  it('fails when status is discontinued', async () => {
    await expect(
      productsService.createProduct(
        { name: 'Cheese Fries', status: 'discontinued', is_seasonal: false, branch_exclusive: false },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREATE_STATUS', statusCode: 422 });

    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
  });

  it('fails when status is archived', async () => {
    await expect(
      productsService.createProduct(
        { name: 'Cheese Fries', status: 'archived', is_seasonal: false, branch_exclusive: false },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREATE_STATUS', statusCode: 422 });

    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
  });

  it('rejects a seasonal product missing both dates', async () => {
    await expect(
      productsService.createProduct(
        { name: 'Halo-Halo Fries', status: 'draft', is_seasonal: true, branch_exclusive: false },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'SEASONAL_DATES_REQUIRED', statusCode: 422 });

    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
  });

  it('rejects a seasonal product whose end date precedes its start date', async () => {
    await expect(
      productsService.createProduct(
        {
          name: 'Halo-Halo Fries',
          status: 'draft',
          is_seasonal: true,
          seasonal_start_date: '2026-06-01',
          seasonal_end_date: '2026-05-01',
          branch_exclusive: false,
        },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'SEASONAL_DATE_RANGE_INVALID', statusCode: 422 });

    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
  });

  // CR-001
  it('cascades to all active branches when branch_exclusive is false', async () => {
    vi.mocked(productsRepository.createWithCascade).mockResolvedValue(
      buildCreateResult({ status: 'active', branchExclusive: false }, ['branch-a', 'branch-b', 'branch-c']) as never,
    );

    await productsService.createProduct({ name: 'Cheese Fries', status: 'active', is_seasonal: false, branch_exclusive: false }, SUPER_ADMIN, null);

    expect(productsRepository.createWithCascade).toHaveBeenCalledWith(
      expect.objectContaining({ branchExclusive: false, exclusiveBranchId: undefined }),
      SUPER_ADMIN.id,
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PRODUCT_CATALOG_CASCADE',
        afterState: expect.objectContaining({ branchExclusive: false, branchCount: 3 }),
      }),
    );
  });

  it('only creates a branch_product_availability row for the exclusive branch when branch_exclusive is true', async () => {
    vi.mocked(productsRepository.findActiveBranch).mockResolvedValue({ id: 'branch-a', name: 'Main' } as never);
    vi.mocked(productsRepository.createWithCascade).mockResolvedValue(
      buildCreateResult({ status: 'active', branchExclusive: true, exclusiveBranchId: 'branch-a' }, ['branch-a']) as never,
    );

    await productsService.createProduct(
      { name: 'Branch Special Fries', status: 'active', is_seasonal: false, branch_exclusive: true, exclusive_branch_id: 'branch-a' },
      SUPER_ADMIN,
      null,
    );

    expect(productsRepository.createWithCascade).toHaveBeenCalledWith(
      expect.objectContaining({ branchExclusive: true, exclusiveBranchId: 'branch-a' }),
      SUPER_ADMIN.id,
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PRODUCT_CATALOG_CASCADE',
        afterState: expect.objectContaining({ branchExclusive: true, cascadedToBranchIds: ['branch-a'], branchCount: 1 }),
      }),
    );
  });

  it('rejects branch_exclusive true without exclusive_branch_id', async () => {
    await expect(
      productsService.createProduct(
        { name: 'Branch Special Fries', status: 'active', is_seasonal: false, branch_exclusive: true },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'EXCLUSIVE_BRANCH_REQUIRED', statusCode: 422 });

    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
  });

  it('rejects branch_exclusive true when the branch is not active', async () => {
    vi.mocked(productsRepository.findActiveBranch).mockResolvedValue(null);

    await expect(
      productsService.createProduct(
        { name: 'Branch Special Fries', status: 'active', is_seasonal: false, branch_exclusive: true, exclusive_branch_id: 'branch-z' },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'EXCLUSIVE_BRANCH_NOT_FOUND', statusCode: 422 });

    expect(productsRepository.createWithCascade).not.toHaveBeenCalled();
  });
});

describe('productsService.updateProduct', () => {
  it('rejects updating an archived product', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'archived' }) as never);

    await expect(productsService.updateProduct('prod-1', { name: 'New Name' }, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'PRODUCT_ARCHIVED',
      statusCode: 409,
    });

    expect(productsRepository.update).not.toHaveBeenCalled();
  });
});

describe('productsService.changeProductStatus — super_admin global transitions', () => {
  it('draft -> active succeeds', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'draft' }) as never);
    vi.mocked(productsRepository.updateStatus).mockResolvedValue(buildProduct({ status: 'active' }) as never);

    const result = await productsService.changeProductStatus('prod-1', { status: 'active' }, SUPER_ADMIN, null);

    expect(productsRepository.updateStatus).toHaveBeenCalledWith('prod-1', 'active');
    expect((result as { status: string }).status).toBe('active');
  });

  it('active -> discontinued succeeds', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.updateStatus).mockResolvedValue(buildProduct({ status: 'discontinued' }) as never);

    await productsService.changeProductStatus('prod-1', { status: 'discontinued' }, SUPER_ADMIN, null);

    expect(productsRepository.updateStatus).toHaveBeenCalledWith('prod-1', 'discontinued');
  });

  it('discontinued -> active succeeds', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'discontinued' }) as never);
    vi.mocked(productsRepository.updateStatus).mockResolvedValue(buildProduct({ status: 'active' }) as never);

    await productsService.changeProductStatus('prod-1', { status: 'active' }, SUPER_ADMIN, null);

    expect(productsRepository.updateStatus).toHaveBeenCalledWith('prod-1', 'active');
  });

  it('any status can transition to archived', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'temporarily_unavailable' }) as never);
    vi.mocked(productsRepository.updateStatus).mockResolvedValue(buildProduct({ status: 'archived' }) as never);

    await productsService.changeProductStatus('prod-1', { status: 'archived' }, SUPER_ADMIN, null);

    expect(productsRepository.updateStatus).toHaveBeenCalledWith('prod-1', 'archived');
  });

  it('archived -> active fails', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'archived' }) as never);

    await expect(productsService.changeProductStatus('prod-1', { status: 'active' }, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      statusCode: 409,
    });

    expect(productsRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('discontinuing a product cascades branch availability off and logs the cascade', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.updateStatus).mockResolvedValue(buildProduct({ status: 'discontinued' }) as never);

    await productsService.changeProductStatus('prod-1', { status: 'discontinued' }, SUPER_ADMIN, null);

    expect(productsRepository.cascadeBranchAvailabilityOff).toHaveBeenCalledWith('prod-1', SUPER_ADMIN.id);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_CATALOG_REMOVAL_CASCADE' }));
  });

  it('archiving a product cascades all branch_product_availability rows to unavailable (CR-001)', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.updateStatus).mockResolvedValue(buildProduct({ status: 'archived' }) as never);

    await productsService.changeProductStatus('prod-1', { status: 'archived' }, SUPER_ADMIN, null);

    expect(productsRepository.cascadeBranchAvailabilityOff).toHaveBeenCalledWith('prod-1', SUPER_ADMIN.id);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_CATALOG_REMOVAL_CASCADE', afterState: expect.objectContaining({ cascadedTo: 'unavailable' }) }),
    );
  });
});

describe('productsService.changeProductStatus — supervisor branch-scoped changes', () => {
  it('never mutates the global product status', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.upsertBranchProductAvailability).mockResolvedValue({
      id: 'row-1',
      branchId: 'branch-a',
      isAvailable: false,
      updatedAt: new Date(),
      branch: { code: 'PC-MNL-001', name: 'Main', city: 'Manila' },
    } as never);

    await productsService.changeProductStatus(
      'prod-1',
      { status: 'temporarily_unavailable', branch_id: 'branch-a' },
      SUPERVISOR,
      null,
    );

    expect(productsRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('can set branch-scoped temporarily_unavailable', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.upsertBranchProductAvailability).mockResolvedValue({
      id: 'row-1',
      branchId: 'branch-a',
      isAvailable: false,
      updatedAt: new Date(),
      branch: { code: 'PC-MNL-001', name: 'Main', city: 'Manila' },
    } as never);

    const result = await productsService.changeProductStatus(
      'prod-1',
      { status: 'temporarily_unavailable', branch_id: 'branch-a' },
      SUPERVISOR,
      null,
    );

    expect(productsRepository.upsertBranchProductAvailability).toHaveBeenCalledWith('branch-a', 'prod-1', false, SUPERVISOR.id);
    expect((result as { is_available: boolean }).is_available).toBe(false);
  });

  it('can re-enable branch-scoped active', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.upsertBranchProductAvailability).mockResolvedValue({
      id: 'row-1',
      branchId: 'branch-a',
      isAvailable: true,
      updatedAt: new Date(),
      branch: { code: 'PC-MNL-001', name: 'Main', city: 'Manila' },
    } as never);

    await productsService.changeProductStatus('prod-1', { status: 'active', branch_id: 'branch-a' }, SUPERVISOR, null);

    expect(productsRepository.upsertBranchProductAvailability).toHaveBeenCalledWith('branch-a', 'prod-1', true, SUPERVISOR.id);
  });

  it('cannot enable a globally discontinued product', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'discontinued' }) as never);

    await expect(
      productsService.changeProductStatus('prod-1', { status: 'active', branch_id: 'branch-a' }, SUPERVISOR, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_GLOBALLY_UNAVAILABLE', statusCode: 403 });

    expect(productsRepository.upsertBranchProductAvailability).not.toHaveBeenCalled();
  });
});

describe('productsService.createVariant', () => {
  it('fails on an archived product', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'archived' }) as never);

    await expect(
      productsService.createVariant('prod-1', { name: 'Large', size_label: 'Large', base_price: 85, is_active: true }, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_ARCHIVED', statusCode: 409 });

    expect(productsRepository.createVariant).not.toHaveBeenCalled();
  });
});

describe('productsService.uploadProductImage', () => {
  it('updates image_url and records an audit log entry', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.updateImage).mockResolvedValue(
      buildProduct({ status: 'active', imageUrl: 'https://cdn.test/product-images/img.webp' }) as never,
    );

    const result = await productsService.uploadProductImage(
      'prod-1',
      { buffer: Buffer.from('fake'), originalname: 'fries.jpg' },
      SUPER_ADMIN,
      null,
    );

    expect(result.image_url).toBe('https://cdn.test/product-images/img.webp');
    expect(productsRepository.updateImage).toHaveBeenCalledWith('prod-1', 'https://cdn.test/product-images/img.webp');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_IMAGE_UPLOADED' }));
  });
});

describe('productsService.deleteProduct', () => {
  it('deletes the product cascade and records an audit log entry', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ variants: [buildVariant()] }) as never);
    vi.mocked(productsRepository.deleteProductCascade).mockResolvedValue(buildProduct() as never);

    await productsService.deleteProduct('prod-1', SUPER_ADMIN, null);

    expect(productsRepository.deleteProductCascade).toHaveBeenCalledWith('prod-1', ['variant-1']);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_DELETED', entityId: 'prod-1' }));
  });

  it('maps a P2003 foreign key violation to a 409 with a friendly message', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ variants: [] }) as never);
    vi.mocked(productsRepository.deleteProductCascade).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: '5.0.0' }),
    );

    await expect(productsService.deleteProduct('prod-1', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'PRODUCT_HAS_DEPENDENCIES',
      statusCode: 409,
    });

    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

describe('productsService.deleteVariant', () => {
  it('deletes the variant cascade and records an audit log entry', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant() as never);
    vi.mocked(productsRepository.deleteVariantCascade).mockResolvedValue(buildVariant() as never);

    await productsService.deleteVariant('prod-1', 'variant-1', SUPER_ADMIN, null);

    expect(productsRepository.deleteVariantCascade).toHaveBeenCalledWith('variant-1');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_VARIANT_DELETED', entityId: 'variant-1' }));
  });

  it('maps a P2003 foreign key violation to a 409 with a friendly message', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant() as never);
    vi.mocked(productsRepository.deleteVariantCascade).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: '5.0.0' }),
    );

    await expect(productsService.deleteVariant('prod-1', 'variant-1', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_HAS_DEPENDENCIES',
      statusCode: 409,
    });

    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

describe('productsService.deleteProductImage', () => {
  it('removes the Storage object, clears image_url, and records an audit log entry', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(
      buildProduct({ imageUrl: 'https://cdn.test/storage/v1/object/public/product-images/product-images/prod-1/img.webp' }) as never,
    );
    vi.mocked(productsRepository.clearImage).mockResolvedValue(buildProduct({ imageUrl: null }) as never);

    const result = await productsService.deleteProductImage('prod-1', SUPER_ADMIN, null);

    expect(result.image_url).toBeNull();
    expect(productsRepository.clearImage).toHaveBeenCalledWith('prod-1');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_IMAGE_DELETED' }));
  });

  it('still clears image_url when Supabase Storage removal fails', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(
      buildProduct({ imageUrl: 'https://cdn.test/storage/v1/object/public/product-images/product-images/prod-1/img.webp' }) as never,
    );
    vi.mocked(productsRepository.clearImage).mockResolvedValue(buildProduct({ imageUrl: null }) as never);
    vi.mocked(supabaseAdmin.storage.from).mockReturnValueOnce({
      remove: vi.fn().mockResolvedValue({ error: 'boom' }),
    } as never);

    const result = await productsService.deleteProductImage('prod-1', SUPER_ADMIN, null);

    expect(result.image_url).toBeNull();
    expect(productsRepository.clearImage).toHaveBeenCalledWith('prod-1');
  });
});

// --- CR-005 Sub-phase 3c — variant lifecycle ---

describe('productsService — VARIANT_TRANSITIONS matrix', () => {
  beforeEach(() => {
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([]);
    vi.mocked(productsRepository.allActiveBranches).mockResolvedValue([]);
  });

  it('DRAFT allows PENDING_APPROVAL and ARCHIVED, rejects ACTIVE', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    await expect(productsService.submitVariantForApproval('variant-1', SUPER_ADMIN, null)).resolves.toBeDefined();

    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
  });

  it('PENDING_APPROVAL allows ACTIVE, DRAFT, and ARCHIVED, rejects re-submission', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);
    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).resolves.toBeDefined();

    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    await expect(productsService.rejectVariant('variant-1', 'needs fixes', SUPER_ADMIN, null)).resolves.toBeDefined();

    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    await expect(productsService.archiveVariant('variant-1', undefined, SUPER_ADMIN, null)).resolves.toBeDefined();

    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    await expect(productsService.submitVariantForApproval('variant-1', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
  });

  it('ACTIVE allows only ARCHIVED', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ARCHIVED' }) as never);
    await expect(productsService.archiveVariant('variant-1', undefined, SUPER_ADMIN, null)).resolves.toBeDefined();

    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);
    await expect(productsService.submitVariantForApproval('variant-1', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
  });

  it('ARCHIVED is terminal — every transition is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ARCHIVED' }) as never);

    await expect(productsService.archiveVariant('variant-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
    await expect(productsService.rejectVariant('variant-1', 'reason', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
    await expect(productsService.submitVariantForApproval('variant-1', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
  });
});

describe('productsService.submitVariantForApproval', () => {
  beforeEach(() => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
  });

  it('supervisor can submit a DRAFT variant for approval', async () => {
    const result = await productsService.submitVariantForApproval('variant-1', SUPERVISOR, null);

    expect(result.lifecycle_status).toBe('PENDING_APPROVAL');
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith('variant-1', { lifecycleStatus: 'PENDING_APPROVAL' });
    expect(notifySuperAdmin).toHaveBeenCalledWith(SOCKET_EVENTS.VARIANT_SUBMITTED_FOR_APPROVAL, expect.anything());
  });

  it('super_admin can submit a DRAFT variant for approval', async () => {
    const result = await productsService.submitVariantForApproval('variant-1', SUPER_ADMIN, null);
    expect(result.lifecycle_status).toBe('PENDING_APPROVAL');
  });

  it('staff/branch role gets 403', async () => {
    await expect(productsService.submitVariantForApproval('variant-1', BRANCH_ACTOR, null)).rejects.toMatchObject({
      code: 'VARIANT_SUBMIT_FORBIDDEN',
      statusCode: 403,
    });
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
  });
});

describe('productsService.approveVariant', () => {
  beforeEach(() => {
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([]);
    vi.mocked(productInventoryRepository.hasAnyActiveMappingForVariant).mockResolvedValue(true);
    vi.mocked(productsRepository.allActiveBranches).mockResolvedValue([
      { id: 'branch-a', code: 'PC-A-001', name: 'Branch A', city: 'Manila' },
    ] as never);
  });

  it('super_admin approves a PENDING_APPROVAL variant with no gate blockers', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'ACTIVE', approvedById: SUPER_ADMIN.id }) as never,
    );

    vi.mocked(productsRepository.findBranchProductAvailability).mockResolvedValue([
      { branchId: 'branch-a', isAvailable: true, updatedAt: new Date(), branch: { code: 'PC-A-001', name: 'Branch A', city: 'Manila' } },
    ] as never);

    const result = await productsService.approveVariant('variant-1', 'looks good', SUPER_ADMIN, null);

    expect(result.lifecycle_status).toBe('ACTIVE');
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith(
      'variant-1',
      expect.objectContaining({ lifecycleStatus: 'ACTIVE', approvedById: SUPER_ADMIN.id, lastChangeReason: 'looks good' }),
    );
    expect(notifyBranch).toHaveBeenCalledWith('branch-a', SOCKET_EVENTS.VARIANT_APPROVED, expect.anything());
    expect(notifySuperAdmin).toHaveBeenCalledWith(SOCKET_EVENTS.VARIANT_APPROVED, expect.anything());
    expect(productInventoryRepository.hasAnyActiveMappingForVariant).toHaveBeenCalledWith('variant-1');
    expect(productInventoryRepository.hasMappingForVariant).not.toHaveBeenCalled();
  });

  it('supervisor gets 403', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);

    await expect(productsService.approveVariant('variant-1', undefined, SUPERVISOR, null)).rejects.toMatchObject({
      code: 'VARIANT_APPROVE_FORBIDDEN',
      statusCode: 403,
    });
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
  });

  it('reason is optional — approval succeeds without one', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);

    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).resolves.toBeDefined();
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith('variant-1', expect.objectContaining({ lastChangeReason: null }));
  });

  it('approves a variant with valid, contiguous ProductFlavorSlot rows', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([
      { id: 'slot-1', productVariantId: 'variant-1', slotIndex: 1, label: 'Flavor 1', flavorQty: new Prisma.Decimal(1), unit: 'scoop', required: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'slot-2', productVariantId: 'variant-1', slotIndex: 2, label: 'Flavor 2', flavorQty: new Prisma.Decimal(1), unit: 'scoop', required: true, createdAt: new Date(), updatedAt: new Date() },
    ] as never);

    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).resolves.toBeDefined();
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalled();
  });

  it('rejects approval when ProductFlavorSlot rows have a duplicate slot index', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([
      { id: 'slot-1', productVariantId: 'variant-1', slotIndex: 1, label: 'Flavor 1', flavorQty: new Prisma.Decimal(1), unit: 'scoop', required: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'slot-2', productVariantId: 'variant-1', slotIndex: 1, label: 'Flavor 2', flavorQty: new Prisma.Decimal(1), unit: 'scoop', required: true, createdAt: new Date(), updatedAt: new Date() },
    ] as never);

    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_APPROVAL_MALFORMED_FLAVOR_SLOTS',
      statusCode: 409,
    });
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
  });

  it('Guarantee 6 gate blocks approval when the variant has no active ProductInventory mapping in any branch', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productInventoryRepository.hasAnyActiveMappingForVariant).mockResolvedValue(false);

    await expect(productsService.approveVariant('variant-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_APPROVAL_BLOCKED_UNRESOLVABLE_INGREDIENT',
      statusCode: 409,
    });
    expect(productInventoryRepository.hasAnyActiveMappingForVariant).toHaveBeenCalledWith('variant-1');
    expect(productInventoryRepository.hasMappingForVariant).not.toHaveBeenCalled();
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
  });
});

describe('productsService.rejectVariant', () => {
  it('super_admin rejects a PENDING_APPROVAL variant back to DRAFT with a reason', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'PENDING_APPROVAL' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'DRAFT', lastChangeReason: 'missing recipe' }) as never,
    );

    const result = await productsService.rejectVariant('variant-1', 'missing recipe', SUPER_ADMIN, null);

    expect(result.lifecycle_status).toBe('DRAFT');
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith('variant-1', {
      lifecycleStatus: 'DRAFT',
      lastChangeReason: 'missing recipe',
    });
  });

  it('supervisor gets 403', async () => {
    await expect(productsService.rejectVariant('variant-1', 'missing recipe', SUPERVISOR, null)).rejects.toMatchObject({
      code: 'VARIANT_REJECT_FORBIDDEN',
      statusCode: 403,
    });
    expect(productsRepository.findVariantById).not.toHaveBeenCalled();
  });

  it('empty reason is rejected', async () => {
    await expect(productsService.rejectVariant('variant-1', '   ', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_REJECT_REASON_REQUIRED',
      statusCode: 400,
    });
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
  });

  it('non-PENDING_APPROVAL state is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);

    await expect(productsService.rejectVariant('variant-1', 'reason', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
  });
});

describe('productsService.editActiveVariant', () => {
  it('super_admin edits an ACTIVE variant with a reason and real changes: bumps version, sets reason, inserts change log', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'ACTIVE', version: 1, basePrice: { toNumber: () => 65 } }) as never,
    );
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'ACTIVE', version: 2, basePrice: { toNumber: () => 75 }, lastChangeReason: 'price adjustment' }) as never,
    );

    const result = await productsService.editActiveVariant('variant-1', { base_price: 75 }, 'price adjustment', SUPER_ADMIN, null);

    expect(result.version).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith(
      'variant-1',
      expect.objectContaining({ basePrice: 75, version: 2, lastChangeReason: 'price adjustment' }),
      txMock,
    );
    expect(productsRepository.insertVariantChangeLog).toHaveBeenCalledWith(
      expect.objectContaining({ productVariantId: 'variant-1', version: 2, changedById: SUPER_ADMIN.id, reason: 'price adjustment' }),
      txMock,
    );
  });

  it('supervisor gets 403', async () => {
    await expect(productsService.editActiveVariant('variant-1', { base_price: 75 }, 'reason', SUPERVISOR, null)).rejects.toMatchObject({
      code: 'VARIANT_EDIT_ACTIVE_FORBIDDEN',
      statusCode: 403,
    });
  });

  it('empty reason is rejected', async () => {
    await expect(productsService.editActiveVariant('variant-1', { base_price: 75 }, '  ', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_EDIT_REASON_REQUIRED',
      statusCode: 400,
    });
  });

  it('no actual data changes is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'ACTIVE', name: 'Regular', basePrice: { toNumber: () => 65 } }) as never,
    );

    await expect(productsService.editActiveVariant('variant-1', { name: 'Regular' }, 'reason', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_EDIT_NO_CHANGES',
      statusCode: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('non-ACTIVE state is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);

    await expect(productsService.editActiveVariant('variant-1', { base_price: 75 }, 'reason', SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_NOT_ACTIVE',
      statusCode: 409,
    });
  });
});

describe('productsService.archiveVariant', () => {
  it('super_admin archives an ACTIVE variant: lifecycleStatus ARCHIVED, change log inserted, version not bumped', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'ACTIVE', version: 3, basePrice: { toNumber: () => 65 } }) as never,
    );
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ARCHIVED', version: 3 }) as never);

    const result = await productsService.archiveVariant('variant-1', 'end of season', SUPER_ADMIN, null);

    expect(result.lifecycle_status).toBe('ARCHIVED');
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith(
      'variant-1',
      { lifecycleStatus: 'ARCHIVED', lastChangeReason: 'end of season' },
      txMock,
    );
    expect(productsRepository.insertVariantChangeLog).toHaveBeenCalledWith(
      expect.objectContaining({ productVariantId: 'variant-1', version: 3, reason: 'end of season' }),
      txMock,
    );
  });

  it('cannot archive an already-ARCHIVED variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ARCHIVED' }) as never);

    await expect(productsService.archiveVariant('variant-1', undefined, SUPER_ADMIN, null)).rejects.toMatchObject({
      code: 'VARIANT_INVALID_TRANSITION',
      statusCode: 409,
    });
  });

  it('supervisor gets 403', async () => {
    await expect(productsService.archiveVariant('variant-1', undefined, SUPERVISOR, null)).rejects.toMatchObject({
      code: 'VARIANT_ARCHIVE_FORBIDDEN',
      statusCode: 403,
    });
  });
});

describe('productsService.createVariant — lifecycle_status extension', () => {
  it('existing callers without lifecycle_status still default to ACTIVE (schema default) and record createdById', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.createVariant).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);

    await productsService.createVariant('prod-1', { name: 'Large', size_label: 'Large', base_price: 85, is_active: true }, SUPER_ADMIN, null);

    expect(productsRepository.createVariant).toHaveBeenCalledWith(
      'prod-1',
      expect.objectContaining({ lifecycleStatus: undefined, createdById: SUPER_ADMIN.id }),
    );
  });

  it('a new caller passing lifecycle_status DRAFT gets a DRAFT variant', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue(buildProduct({ status: 'active' }) as never);
    vi.mocked(productsRepository.createVariant).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);

    const result = await productsService.createVariant(
      'prod-1',
      { name: 'Large', size_label: 'Large', base_price: 85, is_active: true, lifecycle_status: 'DRAFT' },
      SUPER_ADMIN,
      null,
    );

    expect(productsRepository.createVariant).toHaveBeenCalledWith('prod-1', expect.objectContaining({ lifecycleStatus: 'DRAFT' }));
    expect(result.lifecycle_status).toBe('DRAFT');
  });
});

// CR-005 Sub-phase 3d — flavor slot CRUD

describe('productsService flavor slots — RBAC governance', () => {
  it('supervisor can add a slot on a DRAFT variant, no version bump, no ChangeLog', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT', maxFlavors: 3 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(0);
    vi.mocked(productsRepository.insertFlavorSlot).mockResolvedValue(buildFlavorSlot() as never);

    const result = await productsService.addFlavorSlot(
      'variant-1',
      { label: 'Flavor A', flavorQty: 10, unit: 'grams' },
      undefined,
      SUPERVISOR,
      null,
    );

    expect(result).toBeDefined();
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
    expect(productsRepository.insertVariantChangeLog).not.toHaveBeenCalled();
  });

  it('supervisor can add a slot on a PENDING_APPROVAL variant, no version bump, no ChangeLog', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(
      buildVariant({ lifecycleStatus: 'PENDING_APPROVAL', maxFlavors: 3 }) as never,
    );
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(0);
    vi.mocked(productsRepository.insertFlavorSlot).mockResolvedValue(buildFlavorSlot() as never);

    await productsService.addFlavorSlot('variant-1', { label: 'Flavor A', flavorQty: 10, unit: 'grams' }, undefined, SUPERVISOR, null);

    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
    expect(productsRepository.insertVariantChangeLog).not.toHaveBeenCalled();
  });

  it('supervisor is blocked (403) mutating slots on an ACTIVE variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE' }) as never);

    await expect(
      productsService.addFlavorSlot('variant-1', { label: 'Flavor A', flavorQty: 10, unit: 'grams' }, 'reason', SUPERVISOR, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_EDIT_FORBIDDEN', statusCode: 403 });
  });

  it('super_admin can mutate slots on an ACTIVE variant with a reason: bumps version, writes ChangeLog', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE', version: 1, maxFlavors: 3 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(0);
    vi.mocked(productsRepository.listVariantFlavorSlots)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([buildFlavorSlot()] as never);
    vi.mocked(productsRepository.insertFlavorSlot).mockResolvedValue(buildFlavorSlot() as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE', version: 2 }) as never);

    const result = await productsService.addFlavorSlot(
      'variant-1',
      { label: 'Flavor A', flavorQty: 10, unit: 'grams' },
      'adding a flavor',
      SUPER_ADMIN,
      null,
    );

    expect(result).toBeDefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith(
      'variant-1',
      { version: 2, lastChangeReason: 'adding a flavor' },
      txMock,
    );
    expect(productsRepository.insertVariantChangeLog).toHaveBeenCalledWith(
      expect.objectContaining({ productVariantId: 'variant-1', version: 2, changedById: SUPER_ADMIN.id, reason: 'adding a flavor' }),
      txMock,
    );
  });

  it('any role is blocked (409) mutating slots on an ARCHIVED variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ARCHIVED' }) as never);

    await expect(
      productsService.addFlavorSlot('variant-1', { label: 'Flavor A', flavorQty: 10, unit: 'grams' }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_ARCHIVED_NO_SLOT_CHANGES', statusCode: 409 });
  });
});

describe('productsService.addFlavorSlot', () => {
  it('auto-assigns slotIndex 0 on an empty variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT', maxFlavors: 3 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(0);
    vi.mocked(productsRepository.insertFlavorSlot).mockResolvedValue(buildFlavorSlot({ slotIndex: 0 }) as never);

    await productsService.addFlavorSlot('variant-1', { label: 'Flavor A', flavorQty: 10, unit: 'grams' }, undefined, SUPER_ADMIN, null);

    expect(productsRepository.insertFlavorSlot).toHaveBeenCalledWith(expect.objectContaining({ slotIndex: 0 }), prisma);
  });

  it('auto-assigns slotIndex N when N slots already exist', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT', maxFlavors: 5 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(2);
    vi.mocked(productsRepository.insertFlavorSlot).mockResolvedValue(buildFlavorSlot({ slotIndex: 2 }) as never);

    await productsService.addFlavorSlot('variant-1', { label: 'Flavor C', flavorQty: 10, unit: 'grams' }, undefined, SUPER_ADMIN, null);

    expect(productsRepository.insertFlavorSlot).toHaveBeenCalledWith(expect.objectContaining({ slotIndex: 2 }), prisma);
  });

  it('rejects when maxFlavors is 0', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT', maxFlavors: 0 }) as never);

    await expect(
      productsService.addFlavorSlot('variant-1', { label: 'Flavor A', flavorQty: 10, unit: 'grams' }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_DOES_NOT_ACCEPT_FLAVORS', statusCode: 400 });
    expect(productsRepository.insertFlavorSlot).not.toHaveBeenCalled();
  });

  it('rejects when currentSlotCount >= maxFlavors', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT', maxFlavors: 2 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(2);

    await expect(
      productsService.addFlavorSlot('variant-1', { label: 'Flavor C', flavorQty: 10, unit: 'grams' }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_MAX_FLAVORS_EXCEEDED', statusCode: 409 });
    expect(productsRepository.insertFlavorSlot).not.toHaveBeenCalled();
  });

  it('validates flavorQty > 0', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT', maxFlavors: 3 }) as never);
    vi.mocked(productsRepository.countVariantFlavorSlots).mockResolvedValue(0);

    await expect(
      productsService.addFlavorSlot('variant-1', { label: 'Flavor A', flavorQty: 0, unit: 'grams' }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_INVALID_QUANTITY', statusCode: 400 });
    expect(productsRepository.insertFlavorSlot).not.toHaveBeenCalled();
  });
});

describe('productsService.updateFlavorSlot', () => {
  it('no changes is rejected', async () => {
    vi.mocked(productsRepository.findFlavorSlotById).mockResolvedValue(
      buildFlavorSlot({ label: 'Same', flavorQty: { toNumber: () => 10 }, unit: 'grams', required: true }) as never,
    );
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);

    await expect(
      productsService.updateFlavorSlot('slot-1', { label: 'Same' }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_EDIT_NO_CHANGES', statusCode: 400 });
    expect(productsRepository.updateFlavorSlot).not.toHaveBeenCalled();
  });

  it('updates label successfully; ACTIVE variant bumps version and writes ChangeLog', async () => {
    vi.mocked(productsRepository.findFlavorSlotById).mockResolvedValue(buildFlavorSlot({ label: 'Old Label' }) as never);
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE', version: 1 }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots)
      .mockResolvedValueOnce([buildFlavorSlot({ label: 'Old Label' })] as never)
      .mockResolvedValueOnce([buildFlavorSlot({ label: 'New Label' })] as never);
    vi.mocked(productsRepository.updateFlavorSlot).mockResolvedValue(buildFlavorSlot({ label: 'New Label' }) as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE', version: 2 }) as never);

    const result = await productsService.updateFlavorSlot('slot-1', { label: 'New Label' }, 'rename', SUPER_ADMIN, null);

    expect((result as { label: string }).label).toBe('New Label');
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith('variant-1', { version: 2, lastChangeReason: 'rename' }, txMock);
    expect(productsRepository.insertVariantChangeLog).toHaveBeenCalledWith(
      expect.objectContaining({ productVariantId: 'variant-1', version: 2, reason: 'rename' }),
      txMock,
    );
  });

  it('updating flavorQty to 0 is rejected', async () => {
    vi.mocked(productsRepository.findFlavorSlotById).mockResolvedValue(buildFlavorSlot({ flavorQty: { toNumber: () => 10 } }) as never);
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);

    await expect(
      productsService.updateFlavorSlot('slot-1', { flavorQty: 0 }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_INVALID_QUANTITY', statusCode: 400 });
    expect(productsRepository.updateFlavorSlot).not.toHaveBeenCalled();
  });
});

describe('productsService.removeFlavorSlot', () => {
  it('removes a slot and shifts higher indices down, without touching recipesRepository or ProductInventory', async () => {
    vi.mocked(productsRepository.findFlavorSlotById).mockResolvedValue(
      buildFlavorSlot({ id: 'slot-2', productVariantId: 'variant-1', slotIndex: 1 }) as never,
    );
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);

    await productsService.removeFlavorSlot('slot-2', undefined, SUPERVISOR, null);

    expect(productsRepository.deleteFlavorSlot).toHaveBeenCalledWith('slot-2', prisma);
    expect(productsRepository.shiftFlavorSlotIndicesDown).toHaveBeenCalledWith('variant-1', 1, prisma);
    expect(productsRepository.updateVariantLifecycle).not.toHaveBeenCalled();
    expect(productInventoryRepository.hasMappingForVariant).not.toHaveBeenCalled();
    expect(productInventoryRepository.hasAnyActiveMappingForVariant).not.toHaveBeenCalled();
  });

  it('removing on an ACTIVE variant bumps version and writes ChangeLog', async () => {
    vi.mocked(productsRepository.findFlavorSlotById).mockResolvedValue(
      buildFlavorSlot({ id: 'slot-2', productVariantId: 'variant-1', slotIndex: 1 }) as never,
    );
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE', version: 5 }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots)
      .mockResolvedValueOnce([
        buildFlavorSlot({ id: 'slot-1', slotIndex: 0 }),
        buildFlavorSlot({ id: 'slot-2', slotIndex: 1 }),
      ] as never)
      .mockResolvedValueOnce([buildFlavorSlot({ id: 'slot-1', slotIndex: 0 })] as never);
    vi.mocked(productsRepository.updateVariantLifecycle).mockResolvedValue(buildVariant({ lifecycleStatus: 'ACTIVE', version: 6 }) as never);

    await productsService.removeFlavorSlot('slot-2', 'no longer offered', SUPER_ADMIN, null);

    expect(productsRepository.deleteFlavorSlot).toHaveBeenCalledWith('slot-2', txMock);
    expect(productsRepository.shiftFlavorSlotIndicesDown).toHaveBeenCalledWith('variant-1', 1, txMock);
    expect(productsRepository.updateVariantLifecycle).toHaveBeenCalledWith(
      'variant-1',
      { version: 6, lastChangeReason: 'no longer offered' },
      txMock,
    );
  });
});

describe('productsService.reorderFlavorSlots', () => {
  it('rewrites all slotIndex values in one call', async () => {
    const s0 = buildFlavorSlot({ id: 's0', slotIndex: 0, label: 'A' });
    const s1 = buildFlavorSlot({ id: 's1', slotIndex: 1, label: 'B' });
    const s2 = buildFlavorSlot({ id: 's2', slotIndex: 2, label: 'C' });
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots)
      .mockResolvedValueOnce([s0, s1, s2] as never)
      .mockResolvedValueOnce([
        { ...s2, slotIndex: 0 },
        { ...s0, slotIndex: 1 },
        { ...s1, slotIndex: 2 },
      ] as never);

    const result = await productsService.reorderFlavorSlots('variant-1', { slotIds: ['s2', 's0', 's1'] }, undefined, SUPERVISOR, null);

    expect(productsRepository.rewriteFlavorSlotOrder).toHaveBeenCalledWith('variant-1', ['s2', 's0', 's1'], prisma);
    expect((result as { id: string }[]).map((s) => s.id)).toEqual(['s2', 's0', 's1']);
  });

  it('reorder does not call recipesRepository or touch ProductInventory mappings', async () => {
    const s0 = buildFlavorSlot({ id: 's0', slotIndex: 0, label: 'A' });
    const s1 = buildFlavorSlot({ id: 's1', slotIndex: 1, label: 'B' });
    const s2 = buildFlavorSlot({ id: 's2', slotIndex: 2, label: 'C' });
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots)
      .mockResolvedValueOnce([s0, s1, s2] as never)
      .mockResolvedValueOnce([
        { ...s2, slotIndex: 0 },
        { ...s0, slotIndex: 1 },
        { ...s1, slotIndex: 2 },
      ] as never);

    await productsService.reorderFlavorSlots('variant-1', { slotIds: ['s2', 's0', 's1'] }, undefined, SUPERVISOR, null);

    expect(productsRepository.rewriteFlavorSlotOrder).toHaveBeenCalledWith('variant-1', ['s2', 's0', 's1'], prisma);
    expect(productInventoryRepository.hasMappingForVariant).not.toHaveBeenCalled();
    expect(productInventoryRepository.hasAnyActiveMappingForVariant).not.toHaveBeenCalled();
  });

  it('length mismatch is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([
      buildFlavorSlot({ id: 's0' }),
      buildFlavorSlot({ id: 's1' }),
    ] as never);

    await expect(
      productsService.reorderFlavorSlots('variant-1', { slotIds: ['s0'] }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_REORDER_LENGTH_MISMATCH', statusCode: 400 });
    expect(productsRepository.rewriteFlavorSlotOrder).not.toHaveBeenCalled();
  });

  it('an ID that does not belong to this variant is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([
      buildFlavorSlot({ id: 's0' }),
      buildFlavorSlot({ id: 's1' }),
    ] as never);

    await expect(
      productsService.reorderFlavorSlots('variant-1', { slotIds: ['s0', 'nonexistent'] }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_REORDER_INVALID_ID', statusCode: 400 });
    expect(productsRepository.rewriteFlavorSlotOrder).not.toHaveBeenCalled();
  });

  it('a duplicate ID is rejected', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant({ lifecycleStatus: 'DRAFT' }) as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([
      buildFlavorSlot({ id: 's0' }),
      buildFlavorSlot({ id: 's1' }),
    ] as never);

    await expect(
      productsService.reorderFlavorSlots('variant-1', { slotIds: ['s0', 's0'] }, undefined, SUPER_ADMIN, null),
    ).rejects.toMatchObject({ code: 'VARIANT_SLOT_REORDER_DUPLICATE_ID', statusCode: 400 });
    expect(productsRepository.rewriteFlavorSlotOrder).not.toHaveBeenCalled();
  });
});

describe('productsService.listFlavorSlots', () => {
  it('returns slots sorted by slotIndex ASC', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant() as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([
      buildFlavorSlot({ id: 's0', slotIndex: 0 }),
      buildFlavorSlot({ id: 's1', slotIndex: 1 }),
    ] as never);

    const result = await productsService.listFlavorSlots('variant-1', SUPER_ADMIN);

    expect(result.map((s) => s.id)).toEqual(['s0', 's1']);
  });

  it('an empty variant returns an empty array', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(buildVariant() as never);
    vi.mocked(productsRepository.listVariantFlavorSlots).mockResolvedValue([]);

    const result = await productsService.listFlavorSlots('variant-1', SUPER_ADMIN);

    expect(result).toEqual([]);
  });

  it('404s on a non-existent variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(null);

    await expect(productsService.listFlavorSlots('nonexistent', SUPER_ADMIN)).rejects.toMatchObject({
      code: 'VARIANT_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('productsService.getPosCatalog — Mix & Max snack options', () => {
  function snackProductVariant(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'snack-1',
      name: 'Small',
      isActive: true,
      product: { id: 'product-2', name: 'Flavored Fries', status: 'active', branchAvailability: [{ isAvailable: true }] },
      variantFlavors: [
        { flavorId: 'flavor-1', pricePremium: { toNumber: () => 0 }, flavor: { name: 'Cheese', colorHex: null } },
        { flavorId: 'flavor-2', pricePremium: { toNumber: () => 0 }, flavor: { name: 'BBQ', colorHex: null } },
      ],
      ...overrides,
    };
  }

  function catalogProduct(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'product-1',
      name: 'Mega Mix',
      category: 'Snacks',
      imageUrl: null,
      variants: [
        {
          id: 'variant-1',
          name: 'Regular',
          sizeLabel: 'Regular',
          basePrice: { toNumber: () => 100 },
          vatableCapAmount: null,
          variantFlavors: [],
          optionGroupAssignments: [],
          flavorSlots: [
            {
              slotIndex: 1,
              label: 'Snack 1 Flavor',
              required: true,
              snackOptions: [{ snackProductVariant: snackProductVariant() }],
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  it('exposes snack_options per flavor slot with product_variant_id, product_name, variant_name, and flavors', async () => {
    vi.mocked(productsRepository.findCatalogForBranch).mockResolvedValue([catalogProduct()] as never);
    vi.mocked(productsRepository.findDisabledFlavorIds).mockResolvedValue([]);

    const result = await productsService.getPosCatalog('branch-1');

    const slot = result.products[0]?.variants[0]?.flavor_slots[0];
    expect(slot?.snack_options).toEqual([
      {
        product_variant_id: 'snack-1',
        product_name: 'Flavored Fries',
        variant_name: 'Small',
        flavors: [
          { flavor_id: 'flavor-1', name: 'Cheese', color_hex: null, price_premium: 0 },
          { flavor_id: 'flavor-2', name: 'BBQ', color_hex: null, price_premium: 0 },
        ],
      },
    ]);
  });

  it('excludes a snack option whose product is inactive, unavailable at the branch, or whose variant is deactivated', async () => {
    vi.mocked(productsRepository.findCatalogForBranch).mockResolvedValue([
      catalogProduct({
        variants: [
          {
            id: 'variant-1',
            name: 'Regular',
            sizeLabel: 'Regular',
            basePrice: { toNumber: () => 100 },
            vatableCapAmount: null,
            variantFlavors: [],
            optionGroupAssignments: [],
            flavorSlots: [
              {
                slotIndex: 1,
                label: 'Snack 1 Flavor',
                required: true,
                snackOptions: [
                  { snackProductVariant: snackProductVariant({ id: 'snack-inactive', isActive: false }) },
                  { snackProductVariant: snackProductVariant({ id: 'snack-not-branch-available', product: { id: 'product-3', name: 'X', status: 'active', branchAvailability: [{ isAvailable: false }] } }) },
                  { snackProductVariant: snackProductVariant({ id: 'snack-product-inactive', product: { id: 'product-4', name: 'Y', status: 'archived', branchAvailability: [{ isAvailable: true }] } }) },
                  { snackProductVariant: snackProductVariant({ id: 'snack-ok' }) },
                ],
              },
            ],
          },
        ],
      }),
    ] as never);
    vi.mocked(productsRepository.findDisabledFlavorIds).mockResolvedValue([]);

    const result = await productsService.getPosCatalog('branch-1');

    const options = result.products[0]?.variants[0]?.flavor_slots[0]?.snack_options ?? [];
    expect(options.map((o) => o.product_variant_id)).toEqual(['snack-ok']);
  });

  it('filters a branch-disabled flavor out of a snack option\'s flavors list, reusing the same disabledFlavors rule as the parent variant', async () => {
    vi.mocked(productsRepository.findCatalogForBranch).mockResolvedValue([catalogProduct()] as never);
    vi.mocked(productsRepository.findDisabledFlavorIds).mockResolvedValue(['flavor-2']);

    const result = await productsService.getPosCatalog('branch-1');

    const flavors = result.products[0]?.variants[0]?.flavor_slots[0]?.snack_options[0]?.flavors ?? [];
    expect(flavors.map((f) => f.flavor_id)).toEqual(['flavor-1']);
  });
});
