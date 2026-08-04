import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    productVariantOptionGroup: { count: vi.fn() },
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
