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

/** Prisma's generated where-input types the AND clause as a possible union/array; tests only need plain object access. */
function whereOf(call: unknown): Record<string, unknown> {
  const { where } = nonNull(call) as { where?: Record<string, unknown> };
  return nonNull(where);
}

function andClausesOf(call: unknown): Record<string, unknown>[] {
  return whereOf(call).AND as Record<string, unknown>[];
}

describe('shadowBomDeductionRepository.findActiveComponentsForVariant', () => {
  it('with no selected options, returns only productOptionId-null rows (base components)', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([stubRow()] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1');

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(whereOf(call)).toMatchObject({
      productVariantId: 'variant-1',
      deletedAt: null,
      isActive: true,
      AND: [{ flavorId: null }, { productOptionId: null }],
    });
  });

  it('includes matching option-scoped rows when a selected option is provided', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', null, ['option-cheese']);

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(andClausesOf(call)).toContainEqual({
      OR: [{ productOptionId: null }, { productOptionId: { in: ['option-cheese'] } }],
    });
  });

  it('excludes unselected option rows (query never widens beyond the passed ids)', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', null, ['option-cheese']);

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    const optionClause = nonNull(andClausesOf(call).find((clause) => 'OR' in clause)) as {
      OR: [{ productOptionId: null }, { productOptionId: { in: string[] } }];
    };
    expect(optionClause.OR[1].productOptionId.in).toEqual(['option-cheese']);
    expect(optionClause.OR[1].productOptionId.in).not.toContain('option-sourcream');
  });

  it('supports multiple selected option ids', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', null, ['option-cheese', 'option-bbq']);

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(andClausesOf(call)).toContainEqual({
      OR: [{ productOptionId: null }, { productOptionId: { in: ['option-cheese', 'option-bbq'] } }],
    });
  });

  it('still applies flavor filtering (base + selected flavor) alongside the base option filter', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', 'flavor-cheese');

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(andClausesOf(call)).toContainEqual({ OR: [{ flavorId: null }, { flavorId: 'flavor-cheese' }] });
    expect(andClausesOf(call)).toContainEqual({ productOptionId: null });
  });

  it('combines flavor filtering and option-scoped filtering when both are selected', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', 'flavor-cheese', ['option-cheese']);

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(andClausesOf(call)).toContainEqual({ OR: [{ flavorId: null }, { flavorId: 'flavor-cheese' }] });
    expect(andClausesOf(call)).toContainEqual({
      OR: [{ productOptionId: null }, { productOptionId: { in: ['option-cheese'] } }],
    });
  });

  it('keeps soft-deleted and inactive rows excluded regardless of option filtering', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', null, ['option-cheese']);

    const call = vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0];
    expect(whereOf(call).deletedAt).toBeNull();
    expect(whereOf(call).isActive).toBe(true);
  });

  it('does not add an orderBy clause -- ordering is unchanged from before this change', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([] as never);

    await shadowBomDeductionRepository.findActiveComponentsForVariant('variant-1', null, ['option-cheese']);

    const call = nonNull(vi.mocked(prisma.productComponent.findMany).mock.calls[0]?.[0]) as { orderBy?: unknown };
    expect(call.orderBy).toBeUndefined();
  });
});
