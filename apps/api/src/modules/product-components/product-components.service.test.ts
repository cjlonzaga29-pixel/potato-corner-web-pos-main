import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./product-components.repository.js', () => ({
  productComponentsRepository: {
    findByVariant: vi.fn(),
    findById: vi.fn(),
    findByVariantAndItem: vi.fn(),
    findByVariantAndItemAnyState: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    findItemById: vi.fn(),
    findUnitById: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: {
    findVariantById: vi.fn(),
  },
}));

vi.mock('../product-options/product-options.repository.js', () => ({
  productOptionsRepository: {
    findOptionById: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { productComponentsRepository: repo } = await import('./product-components.repository.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { productOptionsRepository } = await import('../product-options/product-options.repository.js');
const { productComponentsService } = await import('./product-components.service.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };

function decimal(value: number) {
  return { toNumber: () => value };
}

function buildComponent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'component-1',
    productVariantId: 'variant-1',
    inventoryItemId: 'item-1',
    quantityRequired: decimal(2),
    recipeUnitId: 'unit-kg',
    isActive: true,
    productOptionId: null,
    version: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    inventoryItem: { id: 'item-1', name: 'Cheese Powder', sku: null, baseUnitId: 'unit-kg', baseUnit: { code: 'kg' } },
    recipeUnit: { id: 'unit-kg', code: 'kg' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
});

describe('productComponentsService.createMapping', () => {
  it('rejects a mapping against a non-existent product variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(null);

    await expect(
      productComponentsService.createMapping({ product_variant_id: 'missing-variant', inventory_item_id: 'item-1', quantity_required: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_VARIANT_NOT_FOUND' });
    expect(universalInventoryRepository.findItemById).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate (variant, inventory item) mapping', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(buildComponent() as never);

    await expect(
      productComponentsService.createMapping({ product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'MAPPING_ALREADY_EXISTS' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a mapping against a non-existent inventory item', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(null);

    await expect(
      productComponentsService.createMapping({ product_variant_id: 'variant-1', inventory_item_id: 'missing', quantity_required: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
  });

  it('rejects a mapping against a soft-deleted (inactive) inventory item', async () => {
    // universalInventoryRepository.findItemById already filters deletedAt: null,
    // so a soft-deleted item resolves to null here — same path as "not found".
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(null);

    await expect(
      productComponentsService.createMapping({ product_variant_id: 'variant-1', inventory_item_id: 'deleted-item', quantity_required: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
  });

  it('creates the mapping when the variant and item exist and no duplicate is present', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildComponent() as never);

    const result = await productComponentsService.createMapping(
      { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 2 },
      ACTOR,
      null,
    );

    expect(result.id).toBe('component-1');
    expect(result.quantity_required).toBe(2);
    expect(result.is_active).toBe(true);
  });

  it('maps a concurrent unique-constraint violation (P2002) from a create race to MAPPING_ALREADY_EXISTS', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(
      productComponentsService.createMapping({ product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'MAPPING_ALREADY_EXISTS' });
  });

  it('rethrows an unrelated create error unchanged', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockRejectedValue(new Error('connection lost'));

    await expect(
      productComponentsService.createMapping({ product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 1 }, ACTOR, null),
    ).rejects.toThrow('connection lost');
  });

  it('defaults recipe_unit_id to the inventory item base unit when omitted', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildComponent() as never);

    await productComponentsService.createMapping({ product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 2 }, ACTOR, null);

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ recipeUnitId: 'unit-kg' }));
    expect(universalInventoryRepository.findUnitById).not.toHaveBeenCalled();
  });

  it('accepts a recipe_unit_id equal to the base unit without querying UnitOfMeasure again', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildComponent() as never);

    await productComponentsService.createMapping(
      { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 2, recipe_unit_id: 'unit-kg' },
      ACTOR,
      null,
    );

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ recipeUnitId: 'unit-kg' }));
    expect(universalInventoryRepository.findUnitById).not.toHaveBeenCalled();
  });

  it('accepts a compatible different-unit recipe_unit_id (100 g for a kg item)', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildComponent({ recipeUnitId: 'unit-g', recipeUnit: { id: 'unit-g', code: 'g' } }) as never);
    vi.mocked(universalInventoryRepository.findUnitById).mockImplementation(
      ((id: string) =>
        Promise.resolve(
          id === 'unit-kg' ? { id: 'unit-kg', code: 'kg', dimension: 'WEIGHT', isActive: true } : { id: 'unit-g', code: 'g', dimension: 'WEIGHT', isActive: true },
        )) as never,
    );

    const result = await productComponentsService.createMapping(
      { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 100, recipe_unit_id: 'unit-g' },
      ACTOR,
      null,
    );

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ recipeUnitId: 'unit-g' }));
    expect(result.recipe_unit_code).toBe('g');
  });

  it('rejects a recipe_unit_id with a different UnitDimension than the item base unit', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(universalInventoryRepository.findUnitById).mockImplementation(
      ((id: string) =>
        Promise.resolve(
          id === 'unit-kg' ? { id: 'unit-kg', code: 'kg', dimension: 'WEIGHT', isActive: true } : { id: 'unit-ml', code: 'ml', dimension: 'VOLUME', isActive: true },
        )) as never,
    );

    await expect(
      productComponentsService.createMapping(
        { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 1, recipe_unit_id: 'unit-ml' },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'RECIPE_UNIT_DIMENSION_MISMATCH' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown or inactive recipe_unit_id', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(universalInventoryRepository.findUnitById).mockResolvedValue(null);

    await expect(
      productComponentsService.createMapping(
        { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 1, recipe_unit_id: 'missing-unit' },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'RECIPE_UNIT_NOT_FOUND' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates an option-scoped component when product_option_id references an existing option', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(productOptionsRepository.findOptionById).mockResolvedValue({ id: 'option-1' } as never);
    vi.mocked(repo.create).mockResolvedValue(buildComponent({ productOptionId: 'option-1' }) as never);

    const result = await productComponentsService.createMapping(
      { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 2, product_option_id: 'option-1' },
      ACTOR,
      null,
    );

    expect(productOptionsRepository.findOptionById).toHaveBeenCalledWith('option-1');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ productOptionId: 'option-1' }));
    expect(result.product_option_id).toBe('option-1');
  });

  it('rejects a create when product_option_id does not reference an existing option', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(productOptionsRepository.findOptionById).mockResolvedValue(null);

    await expect(
      productComponentsService.createMapping(
        { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 2, product_option_id: 'missing-option' },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_FOUND' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it.each([
    ['omitted', undefined],
    ['explicit null', null],
  ])('defaults product_option_id to null (Base Recipe) when %s, without looking up an option', async (_label, value) => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1', baseUnitId: 'unit-kg' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildComponent() as never);

    const result = await productComponentsService.createMapping(
      { product_variant_id: 'variant-1', inventory_item_id: 'item-1', quantity_required: 2, product_option_id: value },
      ACTOR,
      null,
    );

    expect(productOptionsRepository.findOptionById).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ productOptionId: null }));
    expect(result.product_option_id).toBeNull();
  });
});

describe('productComponentsService.updateMapping', () => {
  it('rejects updating a mapping that does not exist', async () => {
    vi.mocked(repo.findById).mockResolvedValue(null);

    await expect(productComponentsService.updateMapping('missing', { quantity_required: 3 }, ACTOR, null)).rejects.toMatchObject({
      code: 'MAPPING_NOT_FOUND',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('updates the quantity and returns the updated mapping', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildComponent() as never);
    vi.mocked(repo.update).mockResolvedValue(buildComponent({ quantityRequired: decimal(5), version: 2 }) as never);

    const result = await productComponentsService.updateMapping('component-1', { quantity_required: 5 }, ACTOR, null);

    expect(repo.update).toHaveBeenCalledWith('component-1', { quantityRequired: 5 });
    expect(result.quantity_required).toBe(5);
    expect(result.version).toBe(2);
  });

  it('changes the recipe unit when recipe_unit_id is provided, validated against the item base unit', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildComponent() as never);
    vi.mocked(universalInventoryRepository.findUnitById).mockImplementation(
      ((id: string) =>
        Promise.resolve(
          id === 'unit-kg' ? { id: 'unit-kg', code: 'kg', dimension: 'WEIGHT', isActive: true } : { id: 'unit-g', code: 'g', dimension: 'WEIGHT', isActive: true },
        )) as never,
    );
    vi.mocked(repo.update).mockResolvedValue(
      buildComponent({ quantityRequired: decimal(100), recipeUnitId: 'unit-g', recipeUnit: { id: 'unit-g', code: 'g' }, version: 2 }) as never,
    );

    const result = await productComponentsService.updateMapping('component-1', { quantity_required: 100, recipe_unit_id: 'unit-g' }, ACTOR, null);

    expect(repo.update).toHaveBeenCalledWith('component-1', { quantityRequired: 100, recipeUnitId: 'unit-g' });
    expect(result.recipe_unit_code).toBe('g');
  });

  it('changes product_option_id to a valid option', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildComponent() as never);
    vi.mocked(productOptionsRepository.findOptionById).mockResolvedValue({ id: 'option-2' } as never);
    vi.mocked(repo.update).mockResolvedValue(buildComponent({ productOptionId: 'option-2', version: 2 }) as never);

    const result = await productComponentsService.updateMapping('component-1', { product_option_id: 'option-2' }, ACTOR, null);

    expect(productOptionsRepository.findOptionById).toHaveBeenCalledWith('option-2');
    expect(repo.update).toHaveBeenCalledWith('component-1', { productOptionId: 'option-2' });
    expect(result.product_option_id).toBe('option-2');
  });

  it('clears product_option_id back to null (Base Recipe) without looking up an option', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildComponent({ productOptionId: 'option-1' }) as never);
    vi.mocked(repo.update).mockResolvedValue(buildComponent({ productOptionId: null, version: 2 }) as never);

    const result = await productComponentsService.updateMapping('component-1', { product_option_id: null }, ACTOR, null);

    expect(productOptionsRepository.findOptionById).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('component-1', { productOptionId: null });
    expect(result.product_option_id).toBeNull();
  });

  it('rejects updating to a product_option_id that does not reference an existing option', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildComponent() as never);
    vi.mocked(productOptionsRepository.findOptionById).mockResolvedValue(null);

    await expect(
      productComponentsService.updateMapping('component-1', { product_option_id: 'missing-option' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_FOUND' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('leaves product_option_id untouched when omitted — existing requests without it keep working', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildComponent({ productOptionId: 'option-1' }) as never);
    vi.mocked(repo.update).mockResolvedValue(buildComponent({ productOptionId: 'option-1', quantityRequired: decimal(5), version: 2 }) as never);

    const result = await productComponentsService.updateMapping('component-1', { quantity_required: 5 }, ACTOR, null);

    expect(productOptionsRepository.findOptionById).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('component-1', { quantityRequired: 5 });
    expect(result.product_option_id).toBe('option-1');
  });
});

describe('productComponentsService.listByVariant', () => {
  it('returns product_option_id for each component (Base Recipe and option-scoped)', async () => {
    vi.mocked(repo.findByVariant).mockResolvedValue([
      buildComponent({ id: 'base-component', productOptionId: null }),
      buildComponent({ id: 'option-component', productOptionId: 'option-1' }),
    ] as never);

    const result = await productComponentsService.listByVariant('variant-1');

    expect(result.find((c) => c.id === 'base-component')?.product_option_id).toBeNull();
    expect(result.find((c) => c.id === 'option-component')?.product_option_id).toBe('option-1');
  });
});

describe('productComponentsService.deleteMapping', () => {
  it('rejects deleting a mapping that does not exist', async () => {
    vi.mocked(repo.findById).mockResolvedValue(null);

    await expect(productComponentsService.deleteMapping('missing', ACTOR, null)).rejects.toMatchObject({ code: 'MAPPING_NOT_FOUND' });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('soft-deletes the mapping and records an audit log', async () => {
    const { recordAuditLog } = await import('../../middleware/audit-log.js');
    vi.mocked(repo.findById).mockResolvedValue(buildComponent() as never);
    vi.mocked(repo.delete).mockResolvedValue(undefined as never);

    await productComponentsService.deleteMapping('component-1', ACTOR, null);

    expect(repo.delete).toHaveBeenCalledWith('component-1', ACTOR.id);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_COMPONENT_DELETED', entityId: 'component-1' }));
  });
});
