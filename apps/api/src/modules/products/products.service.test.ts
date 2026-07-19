import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { ROLES } from '@potato-corner/shared';

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
    findBranchProductAvailability: vi.fn(),
    cascadeBranchAvailabilityOff: vi.fn(),
    getProductsByGlobalStatus: vi.fn(),
    allActiveBranches: vi.fn(),
    findActiveBranch: vi.fn(),
    deleteProductCascade: vi.fn(),
    deleteVariantCascade: vi.fn(),
  },
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

function buildVariant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'variant-1',
    productId: 'prod-1',
    name: 'Regular',
    sizeLabel: 'Regular',
    basePrice: { toNumber: () => 65 },
    displayOrder: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    variantFlavors: [],
    ...overrides,
  };
}

const SUPER_ADMIN = { id: 'admin-1', role: ROLES.SUPER_ADMIN };
const SUPERVISOR = { id: 'sup-1', role: ROLES.SUPERVISOR };

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
