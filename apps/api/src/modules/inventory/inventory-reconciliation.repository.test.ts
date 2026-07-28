import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    inventoryIdentityMapping: { findMany: vi.fn() },
    inventoryMovement: { groupBy: vi.fn() },
    ingredient: { findMany: vi.fn() },
    inventoryStock: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    inventoryProjectionOutbox: { groupBy: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { inventoryReconciliationRepository } = await import('./inventory-reconciliation.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inventoryReconciliationRepository.findAcceptedMappings', () => {
  it('only queries accepted statuses with a non-null inventoryItemId, and flattens the branch join', async () => {
    vi.mocked(prisma.inventoryIdentityMapping.findMany).mockResolvedValueOnce([
      { legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', legacyIngredient: { branchId: 'branch-1' } },
    ] as never);

    const rows = await inventoryReconciliationRepository.findAcceptedMappings();

    expect(prisma.inventoryIdentityMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mappingStatus: { in: ['AUTO_MATCHED', 'MANUALLY_MATCHED'] }, inventoryItemId: { not: null } } }),
    );
    expect(rows).toEqual([{ legacyIngredientId: 'ing-1', inventoryItemId: 'item-1', branchId: 'branch-1' }]);
  });
});

describe('inventoryReconciliationRepository.getOutboxStatusCounts', () => {
  it('fills every status bucket, defaulting to 0 for statuses with no rows', async () => {
    vi.mocked(prisma.inventoryProjectionOutbox.groupBy).mockResolvedValueOnce([
      { status: 'pending', _count: { _all: 3 } },
      { status: 'processed', _count: { _all: 10 } },
    ] as never);

    const counts = await inventoryReconciliationRepository.getOutboxStatusCounts();

    expect(counts).toEqual({ pending: 3, processing: 0, deferred: 0, stuck: 0, processed: 10 });
  });
});

describe('inventoryReconciliationRepository.upsertStockRow', () => {
  const tx = prisma as never;

  it('creates with version 1 and the rebuild watermark for a "create" action', async () => {
    await inventoryReconciliationRepository.upsertStockRow(
      { branchId: 'b1', inventoryItemId: 'i1', expectedQuantity: decimal(5), action: 'create', rebuiltThroughAt: new Date('2026-01-01') },
      tx,
    );

    expect(prisma.inventoryStock.create).toHaveBeenCalledWith({
      data: { branchId: 'b1', inventoryItemId: 'i1', quantityOnHand: decimal(5), version: 1, rebuiltThroughAt: new Date('2026-01-01') },
    });
  });

  it('updates quantityOnHand and increments version for an "update" action', async () => {
    await inventoryReconciliationRepository.upsertStockRow(
      { branchId: 'b1', inventoryItemId: 'i1', expectedQuantity: decimal(9), action: 'update', rebuiltThroughAt: new Date('2026-01-02') },
      tx,
    );

    expect(prisma.inventoryStock.update).toHaveBeenCalledWith({
      where: { branchId_inventoryItemId: { branchId: 'b1', inventoryItemId: 'i1' } },
      data: { rebuiltThroughAt: new Date('2026-01-02'), quantityOnHand: decimal(9), version: { increment: 1 } },
    });
  });

  it('only refreshes the watermark for an "unchanged" action — no quantityOnHand or version write', async () => {
    await inventoryReconciliationRepository.upsertStockRow(
      { branchId: 'b1', inventoryItemId: 'i1', expectedQuantity: decimal(9), action: 'unchanged', rebuiltThroughAt: new Date('2026-01-03') },
      tx,
    );

    const call = vi.mocked(prisma.inventoryStock.update).mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ rebuiltThroughAt: new Date('2026-01-03') });
    expect('quantityOnHand' in call.data).toBe(false);
    expect('version' in call.data).toBe(false);
  });
});
