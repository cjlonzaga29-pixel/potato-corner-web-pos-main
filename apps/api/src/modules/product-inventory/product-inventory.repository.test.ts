import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    productInventory: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { productInventoryRepository } = await import('./product-inventory.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productInventoryRepository.findByVariant', () => {
  it('queries by productVariantId ordered by createdAt ascending', async () => {
    vi.mocked(prisma.productInventory.findMany).mockResolvedValue([]);

    await productInventoryRepository.findByVariant('variant-1');

    expect(prisma.productInventory.findMany).toHaveBeenCalledWith({
      where: { productVariantId: 'variant-1' },
      orderBy: { createdAt: 'asc' },
      include: { ingredient: { select: { id: true, name: true } } },
    });
  });
});

describe('productInventoryRepository.findByVariantAndIngredient', () => {
  it('looks up the compound unique key', async () => {
    vi.mocked(prisma.productInventory.findUnique).mockResolvedValue(null);

    await productInventoryRepository.findByVariantAndIngredient('variant-1', 'ingredient-1');

    expect(prisma.productInventory.findUnique).toHaveBeenCalledWith({
      where: { productVariantId_ingredientId: { productVariantId: 'variant-1', ingredientId: 'ingredient-1' } },
    });
  });
});

describe('productInventoryRepository.create', () => {
  it('creates a mapping with the given fields', async () => {
    vi.mocked(prisma.productInventory.create).mockResolvedValue({ id: 'row-1' } as never);

    await productInventoryRepository.create({
      productVariantId: 'variant-1',
      ingredientId: 'ingredient-1',
      quantityRequired: 2.5,
      unit: 'g',
    });

    expect(prisma.productInventory.create).toHaveBeenCalledWith({
      data: { productVariantId: 'variant-1', ingredientId: 'ingredient-1', quantityRequired: 2.5, unit: 'g' },
      include: { ingredient: { select: { id: true, name: true } } },
    });
  });
});

describe('productInventoryRepository.update', () => {
  it('only includes fields that were actually provided', async () => {
    vi.mocked(prisma.productInventory.update).mockResolvedValue({ id: 'row-1' } as never);

    await productInventoryRepository.update('row-1', { unit: 'kg' });

    expect(prisma.productInventory.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { unit: 'kg' },
      include: { ingredient: { select: { id: true, name: true } } },
    });
  });

  it('includes quantityRequired when provided', async () => {
    vi.mocked(prisma.productInventory.update).mockResolvedValue({ id: 'row-1' } as never);

    await productInventoryRepository.update('row-1', { quantityRequired: 3 });

    expect(prisma.productInventory.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { quantityRequired: 3 },
      include: { ingredient: { select: { id: true, name: true } } },
    });
  });
});

describe('productInventoryRepository.delete', () => {
  it('hard-deletes by id', async () => {
    vi.mocked(prisma.productInventory.delete).mockResolvedValue({ id: 'row-1' } as never);

    await productInventoryRepository.delete('row-1');

    expect(prisma.productInventory.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
  });
});
