import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./product-inventory.repository.js', () => ({
  productInventoryRepository: {
    findByVariant: vi.fn(),
    findById: vi.fn(),
    findByVariantAndIngredient: vi.fn(),
    findIngredientForBranch: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: { findVariantById: vi.fn() },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { productInventoryRepository } = await import('./product-inventory.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { productInventoryService } = await import('./product-inventory.service.js');

const ACTOR = { id: 'user-1', role: 'supervisor' };

function decimal(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

function mappingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'row-1',
    productVariantId: 'variant-1',
    ingredientId: 'ingredient-1',
    quantityRequired: decimal(2.5),
    unit: 'g',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ingredient: { name: 'Cheese Powder' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productInventoryService.listByVariant', () => {
  it('maps rows to the response shape', async () => {
    vi.mocked(productInventoryRepository.findByVariant).mockResolvedValue([mappingRow()] as never);

    const result = await productInventoryService.listByVariant('branch-1', 'variant-1');

    expect(result).toEqual([
      {
        id: 'row-1',
        product_variant_id: 'variant-1',
        ingredient_id: 'ingredient-1',
        ingredient_name: 'Cheese Powder',
        quantity_required: 2.5,
        unit: 'g',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('passes branchId unchanged to the repository query', async () => {
    vi.mocked(productInventoryRepository.findByVariant).mockResolvedValue([]);

    await productInventoryService.listByVariant('branch-1', 'variant-1');

    expect(productInventoryRepository.findByVariant).toHaveBeenCalledWith('branch-1', 'variant-1');
  });
});

describe('productInventoryService.createMapping', () => {
  const input = { branch_id: 'branch-1', product_variant_id: 'variant-1', ingredient_id: 'ingredient-1', quantity_required: 2.5, unit: 'g' };

  it('rejects with a branch-access error when data.branch_id is outside the caller\'s allowed branches, before touching any repository lookup', async () => {
    await expect(productInventoryService.createMapping(input, ['branch-2'], ACTOR, null)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
    expect(productsRepository.findVariantById).not.toHaveBeenCalled();
    expect(productInventoryRepository.findIngredientForBranch).not.toHaveBeenCalled();
    expect(productInventoryRepository.create).not.toHaveBeenCalled();
  });

  it('rejects when the product variant does not exist', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(null);

    await expect(productInventoryService.createMapping(input, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'VARIANT_NOT_FOUND',
      statusCode: 404,
    });
    expect(productInventoryRepository.findIngredientForBranch).not.toHaveBeenCalled();
  });

  it('rejects when the ingredient does not exist for data.branch_id — including when it belongs to a different branch', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue(null);

    await expect(productInventoryService.createMapping(input, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_FOUND',
      statusCode: 404,
    });
    expect(productInventoryRepository.findIngredientForBranch).toHaveBeenCalledWith('ingredient-1', 'branch-1');
    expect(productInventoryRepository.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate product_variant_id + ingredient_id mapping with 409, passing branch_id unchanged to the repository lookup', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(mappingRow() as never);

    await expect(productInventoryService.createMapping(input, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_MAPPING_EXISTS',
      statusCode: 409,
    });
    expect(productInventoryRepository.findByVariantAndIngredient).toHaveBeenCalledWith('branch-1', 'variant-1', 'ingredient-1');
    expect(productInventoryRepository.create).not.toHaveBeenCalled();
  });

  it('rejects when the repository finds an inactive but non-deleted matching row — the lookup does not filter isActive, so this row still counts as a duplicate', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(mappingRow({ isActive: false, deletedAt: null }) as never);

    await expect(productInventoryService.createMapping(input, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_MAPPING_EXISTS',
      statusCode: 409,
    });
    expect(productInventoryRepository.create).not.toHaveBeenCalled();
  });

  it('proceeds to create when the only matching row was soft-deleted — the repository lookup excludes deletedAt rows, so it resolves null here', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    vi.mocked(productInventoryRepository.create).mockResolvedValue(mappingRow() as never);

    await expect(productInventoryService.createMapping(input, ['branch-1'], ACTOR, null)).resolves.toMatchObject({ id: 'row-1' });
  });

  it('maps a concurrent-create P2002 to the same 409, not an uncaught 500', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
    vi.mocked(productInventoryRepository.create).mockRejectedValue(p2002);

    await expect(productInventoryService.createMapping(input, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_MAPPING_EXISTS',
      statusCode: 409,
    });
  });

  it('creates the mapping and records an audit log entry when the caller can access data.branch_id and the ingredient belongs to it', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    vi.mocked(productInventoryRepository.create).mockResolvedValue(mappingRow() as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    const result = await productInventoryService.createMapping(input, ['branch-1'], ACTOR, null);

    expect(result.quantity_required).toBe(2.5);
    expect(productInventoryRepository.findByVariantAndIngredient).toHaveBeenCalledWith('branch-1', 'variant-1', 'ingredient-1');
    expect(productInventoryRepository.create).toHaveBeenCalledWith({
      branchId: 'branch-1',
      productVariantId: 'variant-1',
      ingredientId: 'ingredient-1',
      quantityRequired: 2.5,
      unit: 'g',
    });
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_INVENTORY_CREATED', entityId: 'row-1' }));
  });

  it('succeeds for a supervisor with multiple allowed branches creating in any one of them', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    vi.mocked(productInventoryRepository.create).mockResolvedValue(mappingRow() as never);

    await expect(
      productInventoryService.createMapping(input, ['branch-0', 'branch-1', 'branch-2'], ACTOR, null),
    ).resolves.toMatchObject({ id: 'row-1' });
  });

  it('retains existing behavior for global/all-branch access — no branch membership check is applied', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(productInventoryRepository.findIngredientForBranch).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    vi.mocked(productInventoryRepository.create).mockResolvedValue(mappingRow() as never);

    await expect(productInventoryService.createMapping(input, 'all', ACTOR, null)).resolves.toMatchObject({ id: 'row-1' });
  });
});

describe('productInventoryService.updateMapping', () => {
  it('rejects when the mapping does not exist', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);

    await expect(productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
    expect(productInventoryRepository.update).not.toHaveBeenCalled();
  });

  it('rejects with PRODUCT_INVENTORY_NOT_FOUND (not a new deleted-specific code) when the mapping is soft-deleted, and does not record an audit event', async () => {
    // The repository's findById already excludes deletedAt rows, so a soft-deleted mapping resolves null here, same as a missing row.
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    await expect(productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
    expect(productInventoryRepository.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('succeeds for an inactive but non-deleted mapping, since the lookup does not require isActive: true', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow({ isActive: false, deletedAt: null, unit: 'kg' }) as never);
    vi.mocked(productInventoryRepository.update).mockResolvedValue({ count: 1 });

    const result = await productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1'], ACTOR, null);

    expect(result.unit).toBe('kg');
    expect(productInventoryRepository.update).toHaveBeenCalledWith('row-1', { quantityRequired: undefined, unit: 'kg' }, ['branch-1']);
  });

  it('rejects with PRODUCT_INVENTORY_NOT_FOUND (not a branch-access error) when the mapping exists but is outside all allowed branches', async () => {
    // findById is itself branch-scoped, so a cross-branch mapping resolves to null here — the service must not distinguish this from a missing row.
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);

    await expect(
      productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1', 'branch-2'], ACTOR, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_INVENTORY_NOT_FOUND', statusCode: 404 });
    expect(productInventoryRepository.findById).toHaveBeenCalledWith('row-1', ['branch-1', 'branch-2']);
  });

  it('rejects with not found when the repository write itself matches no row (race condition defense)', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow() as never);
    vi.mocked(productInventoryRepository.update).mockResolvedValue({ count: 0 });

    await expect(productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('updates only the provided fields, scoped to the given branchIds, and audit-logs before/after state', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValueOnce(mappingRow() as never).mockResolvedValueOnce(mappingRow({ unit: 'kg' }) as never);
    vi.mocked(productInventoryRepository.update).mockResolvedValue({ count: 1 });
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    const result = await productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1'], ACTOR, null);

    expect(productInventoryRepository.update).toHaveBeenCalledWith('row-1', { quantityRequired: undefined, unit: 'kg' }, ['branch-1']);
    expect(result.unit).toBe('kg');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_INVENTORY_UPDATED' }));
  });

  it('succeeds for a supervisor with multiple allowed branches acting on a mapping in any one of them', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow({ unit: 'kg' }) as never);
    vi.mocked(productInventoryRepository.update).mockResolvedValue({ count: 1 });

    const result = await productInventoryService.updateMapping('row-1', { unit: 'kg' }, ['branch-1', 'branch-2', 'branch-3'], ACTOR, null);

    expect(productInventoryRepository.findById).toHaveBeenCalledWith('row-1', ['branch-1', 'branch-2', 'branch-3']);
    expect(result.unit).toBe('kg');
  });
});

describe('productInventoryService.deleteMapping', () => {
  it('rejects when the mapping does not exist', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);

    await expect(productInventoryService.deleteMapping('row-1', ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
    expect(productInventoryRepository.delete).not.toHaveBeenCalled();
  });

  it('rejects with PRODUCT_INVENTORY_NOT_FOUND (not a branch-access error) when the mapping exists but is outside all allowed branches', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);

    await expect(
      productInventoryService.deleteMapping('row-1', ['branch-1', 'branch-2'], ACTOR, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_INVENTORY_NOT_FOUND', statusCode: 404 });
    expect(productInventoryRepository.findById).toHaveBeenCalledWith('row-1', ['branch-1', 'branch-2']);
    expect(productInventoryRepository.delete).not.toHaveBeenCalled();
  });

  it('rejects with not found when the repository write itself matches no row (race condition defense)', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow() as never);
    vi.mocked(productInventoryRepository.delete).mockResolvedValue({ count: 0 });

    await expect(productInventoryService.deleteMapping('row-1', ['branch-1'], ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('deletes scoped to the given branchIds and audit-logs the before state', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow() as never);
    vi.mocked(productInventoryRepository.delete).mockResolvedValue({ count: 1 });
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    await productInventoryService.deleteMapping('row-1', ['branch-1'], ACTOR, null);

    expect(productInventoryRepository.delete).toHaveBeenCalledWith('row-1', ['branch-1'], ACTOR.id);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_INVENTORY_DELETED' }));
  });

  it('succeeds for a supervisor with multiple allowed branches acting on a mapping in any one of them', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow() as never);
    vi.mocked(productInventoryRepository.delete).mockResolvedValue({ count: 1 });

    await productInventoryService.deleteMapping('row-1', ['branch-1', 'branch-2', 'branch-3'], ACTOR, null);

    expect(productInventoryRepository.findById).toHaveBeenCalledWith('row-1', ['branch-1', 'branch-2', 'branch-3']);
    expect(productInventoryRepository.delete).toHaveBeenCalledWith('row-1', ['branch-1', 'branch-2', 'branch-3'], ACTOR.id);
  });
});
