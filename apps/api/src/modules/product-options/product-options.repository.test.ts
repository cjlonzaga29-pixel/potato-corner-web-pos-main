import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    productVariantOptionGroup: { count: vi.fn() },
    productComponent: { count: vi.fn() },
    productOptionInventoryMapping: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const { prisma } = await import('../../lib/prisma.js');
const { productOptionsRepository } = await import('./product-options.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productOptionsRepository.countVariantAssignments', () => {
  it('counts ProductVariantOptionGroup rows scoped to the group', async () => {
    vi.mocked(prisma.productVariantOptionGroup.count).mockResolvedValue(3);

    const result = await productOptionsRepository.countVariantAssignments('group-1');

    expect(prisma.productVariantOptionGroup.count).toHaveBeenCalledWith({ where: { optionGroupId: 'group-1' } });
    expect(result).toBe(3);
  });
});

describe('productOptionsRepository.countOptionReferences (P3D-P3)', () => {
  it('returns 0 without querying prisma when given no option ids', async () => {
    const result = await productOptionsRepository.countOptionReferences([]);

    expect(result).toBe(0);
    expect(prisma.productComponent.count).not.toHaveBeenCalled();
    expect(prisma.productOptionInventoryMapping.count).not.toHaveBeenCalled();
  });

  it('sums ProductComponent and ProductOptionInventoryMapping rows scoped to the given option ids', async () => {
    vi.mocked(prisma.productComponent.count).mockResolvedValue(2);
    vi.mocked(prisma.productOptionInventoryMapping.count).mockResolvedValue(1);

    const result = await productOptionsRepository.countOptionReferences(['option-1', 'option-2']);

    expect(prisma.productComponent.count).toHaveBeenCalledWith({ where: { productOptionId: { in: ['option-1', 'option-2'] } } });
    expect(prisma.productOptionInventoryMapping.count).toHaveBeenCalledWith({
      where: { productOptionId: { in: ['option-1', 'option-2'] } },
    });
    expect(result).toBe(3);
  });
});

describe('productOptionsRepository.deleteGroup', () => {
  it('deletes the group\'s options before the group itself, inside one transaction', async () => {
    const tx = {
      productOption: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      productOptionGroup: { delete: vi.fn().mockResolvedValue({ id: 'group-1' }) },
    };
    vi.mocked(prisma.$transaction).mockImplementation((cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx));

    await productOptionsRepository.deleteGroup('group-1');

    expect(tx.productOption.deleteMany).toHaveBeenCalledWith({ where: { optionGroupId: 'group-1' } });
    expect(tx.productOptionGroup.delete).toHaveBeenCalledWith({ where: { id: 'group-1' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('never deletes the group if deleting its options fails (no partial cascade)', async () => {
    const tx = {
      productOption: { deleteMany: vi.fn().mockRejectedValue(new Error('constraint violation')) },
      productOptionGroup: { delete: vi.fn() },
    };
    vi.mocked(prisma.$transaction).mockImplementation((cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(tx));

    await expect(productOptionsRepository.deleteGroup('group-1')).rejects.toThrow('constraint violation');
    expect(tx.productOptionGroup.delete).not.toHaveBeenCalled();
  });
});
