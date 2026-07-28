import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    productComponent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { productComponentsRepository } = await import('./product-components.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productComponentsRepository.create', () => {
  it('creates without createdBy for a plain API-created mapping', async () => {
    vi.mocked(prisma.productComponent.create).mockResolvedValue({} as never);

    await productComponentsRepository.create({ productVariantId: 'v1', inventoryItemId: 'i1', quantityRequired: 2 });

    expect(prisma.productComponent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { productVariantId: 'v1', inventoryItemId: 'i1', quantityRequired: 2 } }),
    );
  });

  it('stamps createdBy when the backfill supplies one', async () => {
    vi.mocked(prisma.productComponent.create).mockResolvedValue({} as never);

    await productComponentsRepository.create({ productVariantId: 'v1', inventoryItemId: 'i1', quantityRequired: 2, createdBy: 'system:legacy-backfill' });

    expect(prisma.productComponent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { productVariantId: 'v1', inventoryItemId: 'i1', quantityRequired: 2, createdBy: 'system:legacy-backfill' },
      }),
    );
  });
});

describe('productComponentsRepository.findByVariantAndItemAnyState', () => {
  it('queries without a deletedAt filter, unlike findByVariantAndItem', async () => {
    vi.mocked(prisma.productComponent.findFirst).mockResolvedValue(null);

    await productComponentsRepository.findByVariantAndItemAnyState('v1', 'i1');

    expect(prisma.productComponent.findFirst).toHaveBeenCalledWith({ where: { productVariantId: 'v1', inventoryItemId: 'i1' } });
  });
});
