import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    productVariant: { findMany: vi.fn() },
    branch: { findMany: vi.fn() },
    branchProductAvailability: { findMany: vi.fn() },
    inventoryStock: { findMany: vi.fn() },
    inventoryProjectionOutbox: { findMany: vi.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { recipeReadinessRepository } = await import('./recipe-readiness.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recipeReadinessRepository', () => {
  it('findVariants passes through productId/productVariantId filters and never writes', async () => {
    vi.mocked(prisma.productVariant.findMany).mockResolvedValueOnce([] as never);

    await recipeReadinessRepository.findVariants({ productId: 'product-1' });

    expect(prisma.productVariant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ productId: 'product-1' }) }),
    );
  });

  it('findAllActiveBranches only selects active branches', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValueOnce([] as never);

    await recipeReadinessRepository.findAllActiveBranches();

    expect(prisma.branch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'active' } }));
  });

  it('findConflictedInventoryItemIds only includes items behind an accepted mapping for a deferred/stuck outbox row', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.findMany).mockResolvedValueOnce([
      { movement: { ingredient: { identityMapping: { inventoryItemId: 'item-accepted', mappingStatus: 'AUTO_MATCHED' } } } },
      { movement: { ingredient: { identityMapping: { inventoryItemId: 'item-pending', mappingStatus: 'PENDING' } } } },
      { movement: { ingredient: { identityMapping: null } } },
    ] as never);

    const result = await recipeReadinessRepository.findConflictedInventoryItemIds();

    expect(result).toEqual(new Set(['item-accepted']));
    expect(prisma.inventoryProjectionOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['deferred', 'stuck'] } } }),
    );
  });

  it('findAllStockKeys and findBranchAvailability perform plain reads with no data argument', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(prisma.branchProductAvailability.findMany).mockResolvedValueOnce([] as never);

    await recipeReadinessRepository.findAllStockKeys();
    await recipeReadinessRepository.findBranchAvailability(['product-1']);

    expect(prisma.inventoryStock.findMany).toHaveBeenCalledWith(expect.not.objectContaining({ data: expect.anything() }));
    expect(prisma.branchProductAvailability.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: { in: ['product-1'] } } }),
    );
  });
});
