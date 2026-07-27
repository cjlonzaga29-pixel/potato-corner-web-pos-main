import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    ingredient: { findMany: vi.fn(), count: vi.fn() },
    flavor: { findMany: vi.fn(), count: vi.fn() },
    productInventory: { count: vi.fn() },
    inventoryMovement: { count: vi.fn() },
    unitOfMeasure: { findMany: vi.fn(), count: vi.fn() },
    inventoryCategory: { count: vi.fn() },
    branch: { count: vi.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const {
  fetchLegacyIngredients,
  fetchLegacyFlavors,
  fetchExistingUnitCodes,
  fetchSourceSummary,
} = await import('./migration-source.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLegacyIngredients', () => {
  it('selects only the fields needed for migration analysis, no writes', () => {
    (prisma.ingredient.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    return fetchLegacyIngredients().then(() => {
      expect(prisma.ingredient.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, unit: true, category: true, branchId: true, deletedAt: true },
      });
    });
  });
});

describe('fetchLegacyFlavors', () => {
  it('selects flavor identity-linkage fields', async () => {
    (prisma.flavor.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await fetchLegacyFlavors();
    expect(prisma.flavor.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, ingredientName: true, ingredientUnit: true, isActive: true },
    });
  });
});

describe('fetchExistingUnitCodes', () => {
  it('reads existing UnitOfMeasure codes without writing', async () => {
    (prisma.unitOfMeasure.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ code: 'KG' }]);
    const result = await fetchExistingUnitCodes();
    expect(result).toEqual([{ code: 'KG' }]);
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({ select: { code: true } });
  });
});

describe('fetchSourceSummary', () => {
  it('aggregates counts from every declared legacy source with no writes', async () => {
    (prisma.branch.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    (prisma.ingredient.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(8); // active
    (prisma.inventoryMovement.count as ReturnType<typeof vi.fn>).mockResolvedValue(50);
    (prisma.productInventory.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(15);
    (prisma.flavor.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4);
    (prisma.unitOfMeasure.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.inventoryCategory.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.ingredient.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ unit: 'kg' }, { unit: 'pc' }])
      .mockResolvedValueOnce([{ category: 'RAW' }, { category: 'OTHER' }]);

    const summary = await fetchSourceSummary();

    expect(summary).toEqual({
      branchCount: 3,
      ingredientCount: 10,
      activeIngredientCount: 8,
      softDeletedIngredientCount: 2,
      distinctIngredientUnitCount: 2,
      distinctIngredientCategoryCount: 2,
      productInventoryCount: 20,
      activeProductInventoryCount: 15,
      flavorCount: 5,
      activeFlavorCount: 4,
      inventoryMovementCount: 50,
      existingUnitOfMeasureCount: 0,
      existingInventoryCategoryCount: 0,
    });

    // No write methods exist on any mocked model, so none can have been called —
    // this assertion documents the read-only contract explicitly.
    const writeMethodNames = ['create', 'update', 'delete', 'upsert', 'createMany', 'updateMany', 'deleteMany'];
    for (const model of Object.values(prisma)) {
      for (const method of writeMethodNames) {
        expect((model as Record<string, unknown>)[method]).toBeUndefined();
      }
    }
  });
});
