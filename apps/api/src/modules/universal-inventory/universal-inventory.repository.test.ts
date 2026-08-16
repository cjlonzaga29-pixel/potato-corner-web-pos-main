import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { universalInventoryRepository } from './universal-inventory.repository.js';

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
