import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./product-inventory.repository.js', () => ({
  productInventoryRepository: {
    findByVariant: vi.fn(),
    findById: vi.fn(),
    findByVariantAndIngredient: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: { findVariantById: vi.fn() },
}));

vi.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: { findIngredientById: vi.fn() },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { productInventoryRepository } = await import('./product-inventory.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
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

    const result = await productInventoryService.listByVariant('variant-1');

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
});

describe('productInventoryService.createMapping', () => {
  const input = { product_variant_id: 'variant-1', ingredient_id: 'ingredient-1', quantity_required: 2.5, unit: 'g' };

  it('rejects when the product variant does not exist', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue(null);

    await expect(productInventoryService.createMapping(input, ACTOR, null)).rejects.toMatchObject({
      code: 'VARIANT_NOT_FOUND',
      statusCode: 404,
    });
    expect(inventoryRepository.findIngredientById).not.toHaveBeenCalled();
  });

  it('rejects when the inventory item does not exist', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(null);

    await expect(productInventoryService.createMapping(input, ACTOR, null)).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('rejects a duplicate product_variant_id + ingredient_id mapping with 409', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(mappingRow() as never);

    await expect(productInventoryService.createMapping(input, ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_MAPPING_EXISTS',
      statusCode: 409,
    });
    expect(productInventoryRepository.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent-create P2002 to the same 409, not an uncaught 500', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
    vi.mocked(productInventoryRepository.create).mockRejectedValue(p2002);

    await expect(productInventoryService.createMapping(input, ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_MAPPING_EXISTS',
      statusCode: 409,
    });
  });

  it('creates the mapping and records an audit log entry when validation passes', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1' } as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue({ id: 'ingredient-1' } as never);
    vi.mocked(productInventoryRepository.findByVariantAndIngredient).mockResolvedValue(null);
    vi.mocked(productInventoryRepository.create).mockResolvedValue(mappingRow() as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    const result = await productInventoryService.createMapping(input, ACTOR, null);

    expect(result.quantity_required).toBe(2.5);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_INVENTORY_CREATED', entityId: 'row-1' }));
  });
});

describe('productInventoryService.updateMapping', () => {
  it('rejects when the mapping does not exist', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);

    await expect(productInventoryService.updateMapping('row-1', { unit: 'kg' }, ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('updates only the provided fields and audit-logs before/after state', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow() as never);
    vi.mocked(productInventoryRepository.update).mockResolvedValue(mappingRow({ unit: 'kg' }) as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    const result = await productInventoryService.updateMapping('row-1', { unit: 'kg' }, ACTOR, null);

    expect(productInventoryRepository.update).toHaveBeenCalledWith('row-1', { quantityRequired: undefined, unit: 'kg' });
    expect(result.unit).toBe('kg');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_INVENTORY_UPDATED' }));
  });
});

describe('productInventoryService.deleteMapping', () => {
  it('rejects when the mapping does not exist', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(null);

    await expect(productInventoryService.deleteMapping('row-1', ACTOR, null)).rejects.toMatchObject({
      code: 'PRODUCT_INVENTORY_NOT_FOUND',
      statusCode: 404,
    });
    expect(productInventoryRepository.delete).not.toHaveBeenCalled();
  });

  it('deletes and audit-logs the before state', async () => {
    vi.mocked(productInventoryRepository.findById).mockResolvedValue(mappingRow() as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    await productInventoryService.deleteMapping('row-1', ACTOR, null);

    expect(productInventoryRepository.delete).toHaveBeenCalledWith('row-1');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_INVENTORY_DELETED' }));
  });
});
