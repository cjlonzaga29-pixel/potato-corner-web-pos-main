import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    recipe: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
