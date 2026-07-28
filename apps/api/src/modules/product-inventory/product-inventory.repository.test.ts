import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    productInventory: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    ingredient: {
      findFirst: vi.fn(),
    },
    flavor: {
      findUnique: vi.fn(),
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
  it('scopes the query to branchId, productVariantId, and deletedAt null, ordered by createdAt ascending', async () => {
    vi.mocked(prisma.productInventory.findMany).mockResolvedValue([]);

    await productInventoryRepository.findByVariant('branch-1', 'variant-1');

    expect(prisma.productInventory.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', productVariantId: 'variant-1', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { ingredient: { select: { id: true, name: true } }, flavor: { select: { id: true, name: true } } },
    });
  });

  it('does not exclude inactive (non-deleted) rows — no isActive filter is applied', async () => {
    vi.mocked(prisma.productInventory.findMany).mockResolvedValue([]);

    await productInventoryRepository.findByVariant('branch-1', 'variant-1');

    const call = vi.mocked(prisma.productInventory.findMany).mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('isActive');
  });

  it('does not request mappings belonging to another branch', async () => {
    vi.mocked(prisma.productInventory.findMany).mockResolvedValue([]);

    await productInventoryRepository.findByVariant('branch-1', 'variant-1');

    expect(prisma.productInventory.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'branch-2' }) }),
    );
  });
});

describe('productInventoryRepository.findByVariantForDeduction', () => {
  it('scopes the query to branchId, productVariantId, deletedAt null, isActive true, and base-only flavor when no flavorId is given', async () => {
    vi.mocked(prisma.productInventory.findMany).mockResolvedValue([]);

    await productInventoryRepository.findByVariantForDeduction('branch-1', 'variant-1');

    expect(prisma.productInventory.findMany).toHaveBeenCalledWith({
      where: {
        branchId: 'branch-1',
        productVariantId: 'variant-1',
        deletedAt: null,
        isActive: true,
        flavorId: null,
      },
      include: { ingredient: { select: { id: true, name: true, branchId: true, unit: true, currentStock: true } } },
    });
  });

  it('matches base-or-selected-flavor rows when a flavorId is given', async () => {
    vi.mocked(prisma.productInventory.findMany).mockResolvedValue([]);

    await productInventoryRepository.findByVariantForDeduction('branch-1', 'variant-1', 'flavor-1');

    expect(prisma.productInventory.findMany).toHaveBeenCalledWith({
      where: {
        branchId: 'branch-1',
        productVariantId: 'variant-1',
        deletedAt: null,
        isActive: true,
        OR: [{ flavorId: null }, { flavorId: 'flavor-1' }],
      },
      include: { ingredient: { select: { id: true, name: true, branchId: true, unit: true, currentStock: true } } },
    });
  });
});

describe('productInventoryRepository.hasMappingForVariant', () => {
  it('scopes the count to branchId, productVariantId, deletedAt null, and isActive true', async () => {
    vi.mocked(prisma.productInventory.count).mockResolvedValue(1);

    await productInventoryRepository.hasMappingForVariant('branch-1', 'variant-1');

    expect(prisma.productInventory.count).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', productVariantId: 'variant-1', deletedAt: null, isActive: true },
    });
  });

  it('returns true when at least one matching row exists', async () => {
    vi.mocked(prisma.productInventory.count).mockResolvedValue(2);

    await expect(productInventoryRepository.hasMappingForVariant('branch-1', 'variant-1')).resolves.toBe(true);
  });

  it('returns false when the count is zero — covers deleted, inactive, or another-branch-only mappings, since the where clause already excludes them', async () => {
    vi.mocked(prisma.productInventory.count).mockResolvedValue(0);

    await expect(productInventoryRepository.hasMappingForVariant('branch-1', 'variant-1')).resolves.toBe(false);
  });
});

describe('productInventoryRepository.hasAnyActiveMappingForVariant', () => {
  it('scopes the count to productVariantId, deletedAt null, and isActive true — no branchId', async () => {
    vi.mocked(prisma.productInventory.count).mockResolvedValue(1);

    await productInventoryRepository.hasAnyActiveMappingForVariant('variant-1');

    // Exact-match assertion — deep equality would fail if branchId were present in `where`.
    expect(prisma.productInventory.count).toHaveBeenCalledWith({
      where: { productVariantId: 'variant-1', deletedAt: null, isActive: true },
    });
  });

  it('returns true when at least one matching row exists in any branch', async () => {
    vi.mocked(prisma.productInventory.count).mockResolvedValue(3);

    await expect(productInventoryRepository.hasAnyActiveMappingForVariant('variant-1')).resolves.toBe(true);
  });

  it('returns false when the count is zero — covers deleted or inactive mappings, since the where clause already excludes them', async () => {
    vi.mocked(prisma.productInventory.count).mockResolvedValue(0);

    await expect(productInventoryRepository.hasAnyActiveMappingForVariant('variant-1')).resolves.toBe(false);
  });
});

describe('productInventoryRepository.findByVariantAndIngredient', () => {
  it('scopes the lookup to branchId and excludes soft-deleted rows, defaulting flavorId to null (base mapping) when not provided', async () => {
    vi.mocked(prisma.productInventory.findFirst).mockResolvedValue(null);

    await productInventoryRepository.findByVariantAndIngredient('branch-1', 'variant-1', 'ingredient-1');

    expect(prisma.productInventory.findFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', productVariantId: 'variant-1', ingredientId: 'ingredient-1', flavorId: null, deletedAt: null },
    });
  });

  it('looks up by the given flavorId when provided', async () => {
    vi.mocked(prisma.productInventory.findFirst).mockResolvedValue(null);

    await productInventoryRepository.findByVariantAndIngredient('branch-1', 'variant-1', 'ingredient-1', 'flavor-1');

    expect(prisma.productInventory.findFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', productVariantId: 'variant-1', ingredientId: 'ingredient-1', flavorId: 'flavor-1', deletedAt: null },
    });
  });

});

describe('productInventoryRepository.findIngredientForBranch', () => {
  it('scopes the lookup to both ingredient id and branchId, excluding soft-deleted rows', async () => {
    vi.mocked(prisma.ingredient.findFirst).mockResolvedValue(null);

    await productInventoryRepository.findIngredientForBranch('ingredient-1', 'branch-1');

    expect(prisma.ingredient.findFirst).toHaveBeenCalledWith({
      where: { id: 'ingredient-1', branchId: 'branch-1', deletedAt: null },
    });
  });

  it('resolves null when the ingredient belongs to a different branch', async () => {
    vi.mocked(prisma.ingredient.findFirst).mockResolvedValue(null);

    await expect(productInventoryRepository.findIngredientForBranch('ingredient-1', 'branch-2')).resolves.toBeNull();
  });
});

describe('productInventoryRepository.create', () => {
  it('creates a mapping with the given fields, including branchId', async () => {
    vi.mocked(prisma.productInventory.create).mockResolvedValue({ id: 'row-1' } as never);

    await productInventoryRepository.create({
      branchId: 'branch-1',
      productVariantId: 'variant-1',
      ingredientId: 'ingredient-1',
      quantityRequired: 2.5,
      unit: 'g',
    });

    expect(prisma.productInventory.create).toHaveBeenCalledWith({
      data: {
        branchId: 'branch-1',
        productVariantId: 'variant-1',
        ingredientId: 'ingredient-1',
        flavorId: null,
        quantityRequired: 2.5,
        unit: 'g',
      },
      include: { ingredient: { select: { id: true, name: true } }, flavor: { select: { id: true, name: true } } },
    });
  });
});

describe('productInventoryRepository.create with flavorId', () => {
  it('passes the given flavorId through to the write', async () => {
    vi.mocked(prisma.productInventory.create).mockResolvedValue({ id: 'row-1' } as never);

    await productInventoryRepository.create({
      branchId: 'branch-1',
      productVariantId: 'variant-1',
      ingredientId: 'ingredient-1',
      flavorId: 'flavor-1',
      quantityRequired: 2.5,
      unit: 'g',
    });

    expect(prisma.productInventory.create).toHaveBeenCalledWith({
      data: {
        branchId: 'branch-1',
        productVariantId: 'variant-1',
        ingredientId: 'ingredient-1',
        flavorId: 'flavor-1',
        quantityRequired: 2.5,
        unit: 'g',
      },
      include: { ingredient: { select: { id: true, name: true } }, flavor: { select: { id: true, name: true } } },
    });
  });
});

describe('productInventoryRepository.findFlavorById', () => {
  it('looks up a Flavor by id, selecting only id and name', async () => {
    vi.mocked(prisma.flavor.findUnique).mockResolvedValue({ id: 'flavor-1', name: 'Sour Cream' } as never);

    const result = await productInventoryRepository.findFlavorById('flavor-1');

    expect(prisma.flavor.findUnique).toHaveBeenCalledWith({ where: { id: 'flavor-1' }, select: { id: true, name: true } });
    expect(result).toEqual({ id: 'flavor-1', name: 'Sour Cream' });
  });
});

describe('productInventoryRepository.findById', () => {
  it('scopes the lookup to the given branchIds via an `in` filter, excluding soft-deleted rows', async () => {
    vi.mocked(prisma.productInventory.findFirst).mockResolvedValue(null);

    await productInventoryRepository.findById('row-1', ['branch-1', 'branch-2']);

    expect(prisma.productInventory.findFirst).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null, branchId: { in: ['branch-1', 'branch-2'] } },
      include: { ingredient: { select: { id: true, name: true } }, flavor: { select: { id: true, name: true } } },
    });
  });

  it('omits the branchId filter entirely when branchIds is "all", but still excludes soft-deleted rows', async () => {
    vi.mocked(prisma.productInventory.findFirst).mockResolvedValue(null);

    await productInventoryRepository.findById('row-1', 'all');

    expect(prisma.productInventory.findFirst).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null },
      include: { ingredient: { select: { id: true, name: true } }, flavor: { select: { id: true, name: true } } },
    });
  });

  it('resolves null for a soft-deleted row even when id and branch are otherwise valid', async () => {
    vi.mocked(prisma.productInventory.findFirst).mockResolvedValue(null);

    await expect(productInventoryRepository.findById('row-1', ['branch-1'])).resolves.toBeNull();
    expect(prisma.productInventory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});

describe('productInventoryRepository.update', () => {
  it('only includes fields that were actually provided', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.update('row-1', { unit: 'kg' }, ['branch-1']);

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null, branchId: { in: ['branch-1'] } },
      data: { unit: 'kg', version: { increment: 1 } },
    });
  });

  it('includes quantityRequired when provided', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.update('row-1', { quantityRequired: 3 }, ['branch-1']);

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null, branchId: { in: ['branch-1'] } },
      data: { quantityRequired: 3, version: { increment: 1 } },
    });
  });

  it('includes the branch scope in the write condition, so a row outside branchIds cannot match', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 0 });

    const result = await productInventoryRepository.update('row-1', { unit: 'kg' }, ['branch-1']);

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: { in: ['branch-1'] } }) }),
    );
    expect(result.count).toBe(0);
  });

  it('includes deletedAt: null in the write condition, so a soft-deleted row cannot be matched by the write', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 0 });

    const result = await productInventoryRepository.update('row-1', { unit: 'kg' }, ['branch-1']);

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
    expect(result.count).toBe(0);
  });

  it('includes isActive in the write data when provided, for deactivate/activate', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.update('row-1', { isActive: false }, ['branch-1']);

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null, branchId: { in: ['branch-1'] } },
      data: { isActive: false, version: { increment: 1 } },
    });
  });

  it('does not add isActive to the write condition — an inactive but non-deleted row can still be matched', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.update('row-1', { unit: 'kg' }, ['branch-1']);

    const call = vi.mocked(prisma.productInventory.updateMany).mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('isActive');
  });

  it('omits the branchId filter entirely when branchIds is "all", but still excludes soft-deleted rows', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.update('row-1', { unit: 'kg' }, 'all');

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null },
      data: { unit: 'kg', version: { increment: 1 } },
    });
  });
});

describe('productInventoryRepository.delete', () => {
  it('soft-deletes via updateMany, scoped to the given branchIds via an `in` filter and excluding already-deleted rows', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.delete('row-1', ['branch-1'], 'user-1');

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null, branchId: { in: ['branch-1'] } },
      data: { deletedAt: expect.any(Date), isActive: false, updatedBy: 'user-1' },
    });
  });

  it('sets deletedAt, isActive false, and updatedBy to the authenticated actor', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.delete('row-1', ['branch-1'], 'user-9');

    const call = vi.mocked(prisma.productInventory.updateMany).mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect(call.data.isActive).toBe(false);
    expect(call.data.updatedBy).toBe('user-9');
  });

  it('includes the branch scope in the write condition, so a row outside branchIds cannot match', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 0 });

    const result = await productInventoryRepository.delete('row-1', ['branch-1'], 'user-1');

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: { in: ['branch-1'] } }) }),
    );
    expect(result.count).toBe(0);
  });

  it('includes deletedAt: null in the write condition, so an already soft-deleted row cannot match again', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 0 });

    const result = await productInventoryRepository.delete('row-1', ['branch-1'], 'user-1');

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
    expect(result.count).toBe(0);
  });

  it('omits the branchId filter entirely when branchIds is "all"', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.delete('row-1', 'all', 'user-1');

    expect(prisma.productInventory.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', deletedAt: null },
      data: { deletedAt: expect.any(Date), isActive: false, updatedBy: 'user-1' },
    });
  });

  it('never calls the Prisma hard-delete methods', async () => {
    vi.mocked(prisma.productInventory.updateMany).mockResolvedValue({ count: 1 });

    await productInventoryRepository.delete('row-1', ['branch-1'], 'user-1');

    expect(prisma.productInventory.delete).not.toHaveBeenCalled();
    expect(prisma.productInventory.deleteMany).not.toHaveBeenCalled();
  });
});
