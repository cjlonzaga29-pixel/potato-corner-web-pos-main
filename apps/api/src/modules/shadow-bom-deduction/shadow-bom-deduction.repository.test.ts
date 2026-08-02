import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    productComponent: {
      findMany: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { shadowBomDeductionRepository } = await import('./shadow-bom-deduction.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function stubRow() {
  return {
    inventoryItemId: 'item-1',
    quantityRequired: decimal(1),
    recipeUnitId: 'unit-1',
    inventoryItem: { baseUnitId: 'base-unit-1' },
  };
}

/** Same convention as inventory-projection.repository.test.ts: a throwing helper instead of `!` under noUncheckedIndexedAccess. */
function nonNull<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a non-null value');
  return value;
}

function whereOf(call: unknown): Record<string, unknown> {
  const { where } = nonNull(call) as { where?: Record<string, unknown> };
  return nonNull(where);
}

describe('shadowBomDeductionRepository.findActiveComponentsForVariant', () => {
  it('returns only productOptionId-null rows (base components)', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([stubRow()] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1');

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(whereOf(call)).toMatchObject({
      productVariantId: 'variant-1',
      deletedAt: null,
      isActive: true,
      productOptionId: null,
      flavorId: null,
    });
  });

  it('applies flavor filtering (base + selected flavor) alongside the base option filter', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', 'flavor-cheese');

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(whereOf(call)).toMatchObject({
      productOptionId: null,
      OR: [{ flavorId: null }, { flavorId: 'flavor-cheese' }],
    });
  });

  it('keeps soft-deleted and inactive rows excluded', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1');

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(whereOf(call).deletedAt).toBeNull();
    expect(whereOf(call).isActive).toBe(true);
  });

  it('does not add an orderBy clause -- ordering is unchanged from before this change', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1');

    const call = nonNull(vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0]) as { orderBy?: unknown };
    expect(call.orderBy).toBeUndefined();
  });
});
