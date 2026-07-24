import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    recipe: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    branchRecipeOverride: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { recipesRepository } = await import('./recipes.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recipesRepository.findOverridesByVariantAndBranch', () => {
  it('excludes soft-deleted overrides', async () => {
    vi.mocked(prisma.branchRecipeOverride.findMany).mockResolvedValue([]);

    await recipesRepository.findOverridesByVariantAndBranch('variant-1', 'branch-1');

    expect(prisma.branchRecipeOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productVariantId: 'variant-1', branchId: 'branch-1', deletedAt: null } }),
    );
  });
});

describe('recipesRepository.findOverrideRows', () => {
  it('excludes soft-deleted overrides while still matching base + selected flavor rows', async () => {
    vi.mocked(prisma.branchRecipeOverride.findMany).mockResolvedValue([]);

    await recipesRepository.findOverrideRows('variant-1', 'branch-1', 'flavor-1');

    expect(prisma.branchRecipeOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          productVariantId: 'variant-1',
          branchId: 'branch-1',
          deletedAt: null,
          OR: [{ flavorId: null }, { flavorId: 'flavor-1' }],
        },
      }),
    );
  });
});

describe('recipesRepository.findOverrideById', () => {
  it('reads a single non-deleted override by id via findFirst, not findUnique', async () => {
    const row = { id: 'override-1' };
    vi.mocked(prisma.branchRecipeOverride.findFirst).mockResolvedValue(row as never);

    const result = await recipesRepository.findOverrideById('override-1');

    expect(prisma.branchRecipeOverride.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'override-1', deletedAt: null } }),
    );
    expect(result).toBe(row);
  });
});

describe('recipesRepository.deleteOverride', () => {
  it('sets deletedAt via update — never calls a hard delete', async () => {
    vi.mocked(prisma.branchRecipeOverride.update).mockResolvedValue({ id: 'override-1', deletedAt: new Date() } as never);

    await recipesRepository.deleteOverride('override-1');

    expect(prisma.branchRecipeOverride.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'override-1' }, data: { deletedAt: expect.any(Date) } }),
    );
    expect(prisma.branchRecipeOverride.delete).not.toHaveBeenCalled();
  });
});

describe('recipesRepository.countRecipesReferencingSlot — CR-005 3f', () => {
  it('counts only non-deleted recipes at the given variant + slot index', async () => {
    vi.mocked(prisma.recipe.count).mockResolvedValue(2);

    const result = await recipesRepository.countRecipesReferencingSlot('variant-1', 1);

    expect(prisma.recipe.count).toHaveBeenCalledWith({
      where: { productVariantId: 'variant-1', flavorSlotIndex: 1, deletedAt: null },
    });
    expect(result).toBe(2);
  });
});

describe('recipesRepository.shiftRecipesFlavorSlotIndicesDown — CR-005 3f', () => {
  it('decrements flavorSlotIndex by 1 for every non-deleted recipe above the removed index', async () => {
    vi.mocked(prisma.recipe.updateMany).mockResolvedValue({ count: 3 } as never);

    await recipesRepository.shiftRecipesFlavorSlotIndicesDown('variant-1', 1);

    expect(prisma.recipe.updateMany).toHaveBeenCalledWith({
      where: { productVariantId: 'variant-1', flavorSlotIndex: { gt: 1 }, deletedAt: null },
      data: { flavorSlotIndex: { decrement: 1 } },
    });
  });
});

describe('recipesRepository.cascadeRecipeSlotReindex — CR-005 3f', () => {
  it('remaps every (oldIndex -> newIndex) pair via a two-phase temp-offset update', async () => {
    vi.mocked(prisma.recipe.updateMany).mockResolvedValue({ count: 1 } as never);

    await recipesRepository.cascadeRecipeSlotReindex('variant-1', new Map([[0, 1], [1, 0]]));

    // Phase 1: both old indices move to their new index + TEMP_OFFSET.
    expect(prisma.recipe.updateMany).toHaveBeenNthCalledWith(1, {
      where: { productVariantId: 'variant-1', flavorSlotIndex: 0, deletedAt: null },
      data: { flavorSlotIndex: 10001 },
    });
    expect(prisma.recipe.updateMany).toHaveBeenNthCalledWith(2, {
      where: { productVariantId: 'variant-1', flavorSlotIndex: 1, deletedAt: null },
      data: { flavorSlotIndex: 10000 },
    });
    // Phase 2: settle from the temp offset to the final index.
    expect(prisma.recipe.updateMany).toHaveBeenNthCalledWith(3, {
      where: { productVariantId: 'variant-1', flavorSlotIndex: 10001, deletedAt: null },
      data: { flavorSlotIndex: 1 },
    });
    expect(prisma.recipe.updateMany).toHaveBeenNthCalledWith(4, {
      where: { productVariantId: 'variant-1', flavorSlotIndex: 10000, deletedAt: null },
      data: { flavorSlotIndex: 0 },
    });
    expect(prisma.recipe.updateMany).toHaveBeenCalledTimes(4);
  });
});
