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
    findByVariantForDeduction: vi.fn(),
    hasMappingForVariant: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: { findVariantById: vi.fn() },
}));

vi.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    findIngredientByBranchAndName: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { productInventoryRepository } = await import('./product-inventory.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
const { productInventoryService, computeDeduction, computeDeductionForSlots, assertProductInventoryExists } = await import('./product-inventory.service.js');

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

/**
 * `ingredientBranchId` defaults to 'branch-a' — the branchId every existing
 * test in this file passes to computeDeduction — so that by default a row's
 * own ingredient already belongs to the selling branch and CR-004's
 * resolveIngredientForBranch takes its zero-extra-query fast path (no need
 * to mock inventoryRepository per test). Tests that specifically cover
 * cross-branch resolution pass a different branchId explicitly.
 */
function deductionRow(
  ingredientId: string,
  ingredientName: string,
  quantity: number,
  unit: string,
  flavorId: string | null,
  ingredientBranchId = 'branch-a',
) {
  return {
    id: `pi-${ingredientId}-${flavorId ?? 'base'}`,
    productVariantId: 'variant-1',
    ingredientId,
    flavorId,
    quantityRequired: { toNumber: () => quantity },
    unit,
    version: 1,
    ingredient: { id: ingredientId, name: ingredientName, branchId: ingredientBranchId, unit, currentStock: { toNumber: () => 9999 } },
  };
}

describe('computeDeduction — base/flavor mapping override', () => {
  it('deducts base-only mappings when no flavor is selected', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato', 'Potato', 200, 'g', null),
      deductionRow('oil', 'Cooking Oil', 30, 'ml', null),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 2, branchId: 'branch-a' });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 400 });
    expect(lines.find((l) => l.ingredient_id === 'oil')).toMatchObject({ quantity: 60 });
  });

  it('passes branchId, productVariantId, and flavorId through to the branch-scoped repository lookup', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato', 'Potato', 200, 'g', null),
    ] as never);

    await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(productInventoryRepository.findByVariantForDeduction).toHaveBeenCalledWith('branch-a', 'variant-1', 'flavor-1');
  });

  it('rejects when no branchId is provided — deduction must never fall back to an inferred or unscoped lookup', async () => {
    await expect(
      computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1 }),
    ).rejects.toMatchObject({ code: 'BRANCH_ID_REQUIRED' });
    expect(productInventoryRepository.findByVariantForDeduction).not.toHaveBeenCalled();
  });

  it('only consults the selling branch — mappings from another branch are never requested', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato', 'Potato', 200, 'g', null),
    ] as never);

    await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(productInventoryRepository.findByVariantForDeduction).not.toHaveBeenCalledWith('branch-b', expect.anything(), expect.anything());
  });

  it('deducts flavor-only mappings when the variant has no base mapping for that ingredient', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('sour_cream', 'Sour Cream Powder', 15, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'sour_cream', quantity: 15 });
  });

  it('combines base and flavor mappings for different ingredients', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato', 'Potato', 200, 'g', null),
      deductionRow('sour_cream', 'Sour Cream Powder', 15, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 200 });
    expect(lines.find((l) => l.ingredient_id === 'sour_cream')).toMatchObject({ quantity: 15 });
  });

  it('flavor mapping overrides the base mapping for the same ingredient when the query returns flavor rows first', async () => {
    // Row order deliberately reversed (flavor before base) — the DB gives no
    // ordering guarantee, so the override must not depend on it.
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato', 'Potato', 250, 'g', 'flavor-1'),
      deductionRow('potato', 'Potato', 200, 'g', null),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato', quantity: 250 });
  });

  it('flavor mapping overrides the base mapping for the same ingredient when the query returns base rows first', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato', 'Potato', 200, 'g', null),
      deductionRow('potato', 'Potato', 250, 'g', 'flavor-1'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: 'flavor-1', quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato', quantity: 250 });
  });
});

describe('computeDeduction — CR-004 cross-branch ingredient resolution', () => {
  it('resolves a mapping pinned to a different branch\'s Ingredient to the selling branch\'s own equivalent by name', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue({
      id: 'potato-branch-b',
      name: 'Potato',
    } as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 2, branchId: 'branch-b' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato-branch-b', quantity: 400 });
    expect(inventoryRepository.findIngredientByBranchAndName).toHaveBeenCalledWith('branch-b', 'Potato');
  });

  it('does not resolve (or query inventoryRepository) when the mapping already belongs to the selling branch', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);

    const lines = await computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-a' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredient_id: 'potato-branch-a' });
    expect(inventoryRepository.findIngredientByBranchAndName).not.toHaveBeenCalled();
  });

  it('rejects the deduction when the selling branch has not been provisioned with the mapped ingredient (fails closed, never silently deducts the wrong branch)', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockResolvedValue([
      deductionRow('potato-branch-a', 'Potato', 200, 'g', null, 'branch-a'),
    ] as never);
    vi.mocked(inventoryRepository.findIngredientByBranchAndName).mockResolvedValue(null);

    await expect(
      computeDeduction({ productVariantId: 'variant-1', flavorId: null, quantitySold: 1, branchId: 'branch-b' }),
    ).rejects.toMatchObject({ code: 'INGREDIENT_NOT_PROVISIONED' });
  });
});

describe('computeDeductionForSlots — Phase 4 Mix & Max', () => {
  it('resolves each selected flavor slot independently and deducts base ingredients once', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockImplementation((async (_branch: string, _variant: string, flavorId?: string) => {
      if (!flavorId) return [deductionRow('potato', 'Potato', 200, 'g', null)] as never;
      if (flavorId === 'flavor-1') return [deductionRow('cheese', 'Cheese Powder', 10, 'g', 'flavor-1')] as never;
      if (flavorId === 'flavor-2') return [deductionRow('bbq', 'BBQ Powder', 12, 'g', 'flavor-2')] as never;
      return [] as never;
    }) as never);

    const lines = await computeDeductionForSlots({
      productVariantId: 'variant-1',
      selectedFlavors: [
        { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
        { slotIndex: 2, snackProductVariantId: 'snack-2', flavorId: 'flavor-2' },
      ],
      quantitySold: 1,
      branchId: 'branch-a',
    });

    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 200 });
    expect(lines.find((l) => l.ingredient_id === 'cheese')).toMatchObject({ quantity: 10 });
    expect(lines.find((l) => l.ingredient_id === 'bbq')).toMatchObject({ quantity: 12 });
    expect(lines).toHaveLength(3);
  });

  it('resolves three slots (Tera Mix) independently', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockImplementation((async (_branch: string, _variant: string, flavorId?: string) => {
      if (!flavorId) return [] as never;
      return [deductionRow(`ing-${flavorId}`, flavorId, 5, 'g', flavorId)] as never;
    }) as never);

    const lines = await computeDeductionForSlots({
      productVariantId: 'variant-1',
      selectedFlavors: [
        { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
        { slotIndex: 2, snackProductVariantId: 'snack-2', flavorId: 'flavor-2' },
        { slotIndex: 3, snackProductVariantId: 'snack-3', flavorId: 'flavor-3' },
      ],
      quantitySold: 1,
      branchId: 'branch-a',
    });

    expect(lines).toHaveLength(3);
  });

  it('sums quantity when the same flavor is selected in two different slots, without duplicating base ingredients', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockImplementation((async (_branch: string, _variant: string, flavorId?: string) => {
      if (!flavorId) return [deductionRow('potato', 'Potato', 200, 'g', null)] as never;
      return [deductionRow('cheese', 'Cheese Powder', 10, 'g', 'flavor-1')] as never;
    }) as never);

    const lines = await computeDeductionForSlots({
      productVariantId: 'variant-1',
      selectedFlavors: [
        { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
        { slotIndex: 2, snackProductVariantId: 'snack-2', flavorId: 'flavor-1' },
      ],
      quantitySold: 1,
      branchId: 'branch-a',
    });

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredient_id === 'potato')).toMatchObject({ quantity: 200 });
    expect(lines.find((l) => l.ingredient_id === 'cheese')).toMatchObject({ quantity: 20 });
  });

  it('resolves each slot\'s ProductInventory mappings against the selected snack\'s own variant id, never the Mix & Max parent variant id', async () => {
    vi.mocked(productInventoryRepository.findByVariantForDeduction).mockImplementation((async (_branch: string, _variant: string, flavorId?: string) => {
      if (!flavorId) return [] as never;
      return [deductionRow(`ing-${flavorId}`, flavorId, 5, 'g', flavorId)] as never;
    }) as never);

    await computeDeductionForSlots({
      productVariantId: 'variant-parent',
      selectedFlavors: [{ slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' }],
      quantitySold: 1,
      branchId: 'branch-a',
    });

    expect(productInventoryRepository.findByVariantForDeduction).toHaveBeenCalledWith('branch-a', 'snack-1', 'flavor-1');
    expect(productInventoryRepository.findByVariantForDeduction).not.toHaveBeenCalledWith('branch-a', 'variant-parent', 'flavor-1');
  });

  it('rejects when no branchId is provided', async () => {
    await expect(
      computeDeductionForSlots({ productVariantId: 'variant-1', selectedFlavors: [], quantitySold: 1, branchId: '' }),
    ).rejects.toMatchObject({ code: 'BRANCH_ID_REQUIRED' });
  });
});

describe('assertProductInventoryExists — CR-004', () => {
  it('resolves silently when the variant has at least one ProductInventory mapping', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(true);

    await expect(assertProductInventoryExists('branch-a', 'variant-1')).resolves.toBeUndefined();
  });

  it('passes branchId and productVariantId through to the repository check', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(true);

    await assertProductInventoryExists('branch-a', 'variant-1');

    expect(productInventoryRepository.hasMappingForVariant).toHaveBeenCalledWith('branch-a', 'variant-1');
  });

  it('throws RECIPE_MISSING when the variant has no ProductInventory mapping — a sale must never silently deduct nothing', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(false);

    await expect(assertProductInventoryExists('branch-a', 'variant-1')).rejects.toMatchObject({ code: 'RECIPE_MISSING' });
  });

  it('throws RECIPE_MISSING when the only mapping belongs to another branch — a mapping from one branch must never satisfy validation for a sale at a different branch', async () => {
    vi.mocked(productInventoryRepository.hasMappingForVariant).mockResolvedValue(false);

    await expect(assertProductInventoryExists('branch-b', 'variant-1')).rejects.toMatchObject({ code: 'RECIPE_MISSING' });
    expect(productInventoryRepository.hasMappingForVariant).toHaveBeenCalledWith('branch-b', 'variant-1');
  });
});
