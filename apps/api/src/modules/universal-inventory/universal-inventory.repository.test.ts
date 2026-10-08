import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    inventoryStockMovement: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

import { universalInventoryRepository } from './universal-inventory.repository.js';
import { prisma } from '../../lib/prisma.js';

// SALE MOVEMENT COST SNAPSHOT FIX — createStockMovements (the batched
// counterpart to createStockMovement, and the only path SALE deductions use)
// silently dropped unitCost/totalCost from its createMany payload even
// though CreateStockMovementInput declares both. This is the regression
// test for that specific bug: every other field already round-tripped
// correctly, so only unit_cost/total_cost need direct coverage here.
describe('universalInventoryRepository.createStockMovements', () => {
  it('passes unitCost/totalCost through to the batched createMany payload', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { inventoryStockMovement: { createMany } } as unknown as Prisma.TransactionClient;

    await universalInventoryRepository.createStockMovements(
      [
        {
          branchId: 'branch-1',
          inventoryItemId: 'item-1',
          movementType: 'SALE',
          quantityChange: new Prisma.Decimal(-5),
          quantityBefore: new Prisma.Decimal(100),
          quantityAfter: new Prisma.Decimal(95),
          unitId: 'unit-g',
          referenceType: 'transaction',
          referenceId: 'txn-1',
          unitCost: new Prisma.Decimal(10),
          totalCost: new Prisma.Decimal(50),
        },
      ],
      tx,
    );

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          inventoryItemId: 'item-1',
          unitCost: expect.objectContaining({ toNumber: expect.any(Function) }),
          totalCost: expect.objectContaining({ toNumber: expect.any(Function) }),
        }),
      ],
    });
    const [[{ data }]] = createMany.mock.calls as [[{ data: Array<{ unitCost: Prisma.Decimal; totalCost: Prisma.Decimal }> }]];
    expect(data[0]?.unitCost.toNumber()).toBe(10);
    expect(data[0]?.totalCost.toNumber()).toBe(50);
  });

  it('leaves unitCost/totalCost undefined (never a fabricated 0) when the input omits them', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { inventoryStockMovement: { createMany } } as unknown as Prisma.TransactionClient;

    await universalInventoryRepository.createStockMovements(
      [
        {
          branchId: 'branch-1',
          inventoryItemId: 'item-1',
          movementType: 'SALE',
          quantityChange: new Prisma.Decimal(-5),
          quantityBefore: new Prisma.Decimal(100),
          quantityAfter: new Prisma.Decimal(95),
          unitId: 'unit-g',
          referenceType: 'transaction',
          referenceId: 'txn-1',
        },
      ],
      tx,
    );

    const [[{ data }]] = createMany.mock.calls as [[{ data: Array<{ unitCost?: unknown; totalCost?: unknown }> }]];
    expect(data[0]?.unitCost).toBeUndefined();
    expect(data[0]?.totalCost).toBeUndefined();
  });
});

// POS-PERF-P27 — the branch-facing Order Deductions / Stock Adjustments
// history screens pass `category` instead of a bare `movementType`; the
// repository must translate that into a movementType `in` filter so the
// filtering happens server-side, before pagination/totals.
describe('universalInventoryRepository.findStockMovements', () => {
  beforeEach(() => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockClear();
    vi.mocked(prisma.inventoryStockMovement.count).mockClear();
  });

  it('filters to SALE/SALE_REVERSAL when category is "order_deductions"', async () => {
    await universalInventoryRepository.findStockMovements('branch-1', { category: 'order_deductions', page: 1, limit: 25 });

    expect(vi.mocked(prisma.inventoryStockMovement.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ movementType: { in: ['SALE', 'SALE_REVERSAL'] } }) }),
    );
    expect(vi.mocked(prisma.inventoryStockMovement.count)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ movementType: { in: ['SALE', 'SALE_REVERSAL'] } }) }),
    );
  });

  it('filters to ADJUSTMENT_IN/ADJUSTMENT_OUT when category is "adjustments"', async () => {
    await universalInventoryRepository.findStockMovements('branch-1', { category: 'adjustments', page: 1, limit: 25 });

    expect(vi.mocked(prisma.inventoryStockMovement.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ movementType: { in: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] } }) }),
    );
  });

  it('prefers an explicit movementType over category when both are given', async () => {
    await universalInventoryRepository.findStockMovements('branch-1', {
      category: 'order_deductions',
      movementType: 'SALE',
      page: 1,
      limit: 25,
    });

    expect(vi.mocked(prisma.inventoryStockMovement.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ movementType: 'SALE' }) }),
    );
  });

  it('omits the movementType filter entirely when neither movementType nor category is given — the full-ledger view', async () => {
    await universalInventoryRepository.findStockMovements('branch-1', { page: 1, limit: 25 });

    const [[{ where }]] = vi.mocked(prisma.inventoryStockMovement.findMany).mock.calls as [[{ where: Record<string, unknown> }]];
    expect(where).not.toHaveProperty('movementType');
  });
});
