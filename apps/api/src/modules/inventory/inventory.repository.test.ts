import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * No `.repository.test.ts` file existed anywhere in this codebase before
 * this one — every other module's repository is only exercised indirectly
 * through its service tests (repository mocked). This establishes a direct
 * pattern instead: mock `lib/prisma.js` itself, so we can assert exactly
 * which Prisma calls (and which `where`/`data` shapes) each repository
 * method makes — the thing that actually matters here, since
 * inventory.repository.ts is the *only* place in the codebase allowed to
 * touch Prisma for this module.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    ingredient: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inventoryMovement: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    transaction: {
      update: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { inventoryRepository } = await import('./inventory.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inventoryRepository.findIngredientById', () => {
  it('reads a single non-deleted ingredient by id', async () => {
    const row = { id: 'ing-1', name: 'Potato' };
    vi.mocked(prisma.ingredient.findFirst).mockResolvedValue(row as never);

    const result = await inventoryRepository.findIngredientById('ing-1');

    expect(prisma.ingredient.findFirst).toHaveBeenCalledWith({ where: { id: 'ing-1', deletedAt: null } });
    expect(result).toBe(row);
  });
});

describe('inventoryRepository.findIngredientByIdIncludingDeleted', () => {
  it('does not filter on deletedAt, unlike findIngredientById', async () => {
    vi.mocked(prisma.ingredient.findUnique).mockResolvedValue({ id: 'ing-1' } as never);

    await inventoryRepository.findIngredientByIdIncludingDeleted('ing-1');

    expect(prisma.ingredient.findUnique).toHaveBeenCalledWith({ where: { id: 'ing-1' } });
  });
});

describe('inventoryRepository.findIngredientByBranchAndName', () => {
  it('scopes the lookup to branch + name, excluding soft-deleted rows', async () => {
    vi.mocked(prisma.ingredient.findFirst).mockResolvedValue(null);

    await inventoryRepository.findIngredientByBranchAndName('branch-1', 'Potato');

    expect(prisma.ingredient.findFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', name: 'Potato', deletedAt: null },
    });
  });
});

describe('inventoryRepository.findAllIngredients', () => {
  it('excludes soft-deleted ingredients and does not filter by branch when none is passed', async () => {
    vi.mocked(prisma.ingredient.findMany).mockResolvedValue([]);

    await inventoryRepository.findAllIngredients();

    expect(prisma.ingredient.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  });

  it('scopes to a single branch when branchId is passed', async () => {
    vi.mocked(prisma.ingredient.findMany).mockResolvedValue([]);

    await inventoryRepository.findAllIngredients('branch-1');

    expect(prisma.ingredient.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, branchId: 'branch-1' },
      orderBy: { name: 'asc' },
    });
  });
});

describe('inventoryRepository.createIngredient', () => {
  it('creates the ingredient row with every mapped field', async () => {
    const created = { id: 'ing-1', branchId: 'branch-1', name: 'Potato' };
    vi.mocked(prisma.ingredient.create).mockResolvedValue(created as never);

    const result = await inventoryRepository.createIngredient({
      branchId: 'branch-1',
      name: 'Potato',
      unit: 'kg',
      currentStock: 50,
      lowStockThreshold: 10,
      criticalThreshold: 5,
      unitCost: 20,
    });

    expect(prisma.ingredient.create).toHaveBeenCalledWith({
      data: {
        branchId: 'branch-1',
        name: 'Potato',
        unit: 'kg',
        currentStock: 50,
        lowStockThreshold: 10,
        criticalThreshold: 5,
        unitCost: 20,
      },
    });
    expect(result).toBe(created);
  });
});

describe('inventoryRepository.updateIngredient', () => {
  it('updates the ingredient fields via prisma.ingredient.update, never .delete', async () => {
    vi.mocked(prisma.ingredient.update).mockResolvedValue({ id: 'ing-1', name: 'Potato (Russet)' } as never);

    await inventoryRepository.updateIngredient('ing-1', { name: 'Potato (Russet)', lowStockThreshold: 15 });

    expect(prisma.ingredient.update).toHaveBeenCalledWith({
      where: { id: 'ing-1' },
      data: { name: 'Potato (Russet)', unit: undefined, lowStockThreshold: 15, criticalThreshold: undefined, unitCost: undefined },
    });
  });
});

describe('inventoryRepository.softDeleteIngredient', () => {
  it('sets deletedAt via update — never calls a hard delete', async () => {
    vi.mocked(prisma.ingredient.update).mockResolvedValue({ id: 'ing-1', deletedAt: new Date() } as never);

    await inventoryRepository.softDeleteIngredient('ing-1');

    expect(prisma.ingredient.update).toHaveBeenCalledWith({
      where: { id: 'ing-1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(prisma.ingredient.delete).not.toHaveBeenCalled();
  });
});

describe('inventoryRepository.getCurrentStock', () => {
  it('sums InventoryMovement.quantityChange rather than reading a stored field', async () => {
    vi.mocked(prisma.inventoryMovement.aggregate).mockResolvedValue({ _sum: { quantityChange: decimal(42) } } as never);

    const result = await inventoryRepository.getCurrentStock('ing-1');

    expect(prisma.inventoryMovement.aggregate).toHaveBeenCalledWith({
      where: { ingredientId: 'ing-1' },
      _sum: { quantityChange: true },
    });
    expect(prisma.ingredient.findFirst).not.toHaveBeenCalled();
    expect(prisma.ingredient.findUnique).not.toHaveBeenCalled();
    expect(result.toNumber()).toBe(42);
  });

  it('returns zero (not null/undefined) when the ingredient has no movements yet', async () => {
    vi.mocked(prisma.inventoryMovement.aggregate).mockResolvedValue({ _sum: { quantityChange: null } } as never);

    const result = await inventoryRepository.getCurrentStock('ing-1');

    expect(result.toNumber()).toBe(0);
  });
});

describe('inventoryRepository.getCurrentStockMap', () => {
  it('returns an empty map without querying when given no ingredient ids', async () => {
    const result = await inventoryRepository.getCurrentStockMap([]);

    expect(result.size).toBe(0);
    expect(prisma.inventoryMovement.groupBy).not.toHaveBeenCalled();
  });

  it('batches every id into one groupBy call and maps sums by ingredientId', async () => {
    vi.mocked(prisma.inventoryMovement.groupBy).mockResolvedValue([
      { ingredientId: 'ing-1', _sum: { quantityChange: decimal(10) } },
      { ingredientId: 'ing-2', _sum: { quantityChange: null } },
    ] as never);

    const result = await inventoryRepository.getCurrentStockMap(['ing-1', 'ing-2']);

    expect(prisma.inventoryMovement.groupBy).toHaveBeenCalledWith({
      by: ['ingredientId'],
      where: { ingredientId: { in: ['ing-1', 'ing-2'] } },
      _sum: { quantityChange: true },
    });
    expect(result.get('ing-1')?.toNumber()).toBe(10);
    expect(result.get('ing-2')?.toNumber()).toBe(0);
    // An ingredient with zero movements ever recorded is absent from the
    // result entirely (not zero-filled) — callers must handle the missing
    // case themselves. See branches.repository.ts's branchStats() for the
    // bug this shape caused and the `?? 0` fallback it requires.
    expect(result.has('ing-3')).toBe(false);
  });
});

describe('inventoryRepository.appendMovement', () => {
  const movementTypes = ['stock_in', 'manual_adjustment', 'waste', 'physical_count'] as const;

  it.each(movementTypes)('records a %s movement inside a transaction, deriving quantityBefore/After from the current sum', async (movementType) => {
    vi.mocked(prisma.inventoryMovement.aggregate).mockResolvedValue({ _sum: { quantityChange: decimal(100) } } as never);
    const created = { id: 'mov-1', movementType, quantityBefore: decimal(100), quantityAfter: decimal(90) };
    vi.mocked(prisma.inventoryMovement.create).mockResolvedValue(created as never);

    const result = await inventoryRepository.appendMovement({
      branchId: 'branch-1',
      ingredientId: 'ing-1',
      movementType,
      quantityChange: -10,
      recordedBy: 'user-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.inventoryMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'branch-1',
        ingredientId: 'ing-1',
        movementType,
        quantityChange: -10,
        quantityBefore: expect.any(Prisma.Decimal),
        quantityAfter: expect.any(Prisma.Decimal),
      }),
      include: { ingredient: { select: { name: true } } },
    });
    expect(result).toBe(created);
  });

  it('computes quantityAfter as quantityBefore + quantityChange, not an independent value', async () => {
    vi.mocked(prisma.inventoryMovement.aggregate).mockResolvedValue({ _sum: { quantityChange: decimal(50) } } as never);
    vi.mocked(prisma.inventoryMovement.create).mockImplementation((async (args: unknown) => args) as never);

    await inventoryRepository.appendMovement({
      branchId: 'branch-1',
      ingredientId: 'ing-1',
      movementType: 'stock_in',
      quantityChange: 25,
    });

    const call = vi.mocked(prisma.inventoryMovement.create).mock.calls[0]?.[0] as {
      data: { quantityBefore: Prisma.Decimal; quantityAfter: Prisma.Decimal };
    };
    expect(call.data.quantityBefore.toNumber()).toBe(50);
    expect(call.data.quantityAfter.toNumber()).toBe(75);
  });
});

describe('inventoryRepository.transferStock', () => {
  it('records transfer_out (negative) on the source and transfer_in (positive) on the destination, in one transaction', async () => {
    vi.mocked(prisma.inventoryMovement.aggregate)
      .mockResolvedValueOnce({ _sum: { quantityChange: decimal(100) } } as never) // source current stock
      .mockResolvedValueOnce({ _sum: { quantityChange: decimal(20) } } as never); // destination current stock
    vi.mocked(prisma.inventoryMovement.create)
      .mockResolvedValueOnce({ id: 'mov-out', movementType: 'transfer_out' } as never)
      .mockResolvedValueOnce({ id: 'mov-in', movementType: 'transfer_in' } as never);

    const result = await inventoryRepository.transferStock({
      fromBranchId: 'branch-a',
      fromIngredientId: 'ing-a',
      toBranchId: 'branch-b',
      toIngredientId: 'ing-b',
      quantity: 15,
      recordedBy: 'user-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.inventoryMovement.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        branchId: 'branch-a',
        ingredientId: 'ing-a',
        movementType: 'transfer_out',
        quantityChange: expect.any(Prisma.Decimal),
        referenceId: 'ing-b',
      }),
      include: { ingredient: { select: { name: true } } },
    });
    expect(prisma.inventoryMovement.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        branchId: 'branch-b',
        ingredientId: 'ing-b',
        movementType: 'transfer_in',
        quantityChange: 15,
        referenceId: 'ing-a',
      }),
      include: { ingredient: { select: { name: true } } },
    });

    const outArgs = vi.mocked(prisma.inventoryMovement.create).mock.calls[0]?.[0] as { data: { quantityChange: Prisma.Decimal } };
    expect(outArgs.data.quantityChange.toNumber()).toBe(-15);
    expect(result).toEqual({ transferOut: { id: 'mov-out', movementType: 'transfer_out' }, transferIn: { id: 'mov-in', movementType: 'transfer_in' } });
  });
});

describe('inventoryRepository.hasMovementForReference', () => {
  it('returns true when a movement with that referenceId + movementType already exists', async () => {
    vi.mocked(prisma.inventoryMovement.findFirst).mockResolvedValue({ id: 'mov-1' } as never);

    const result = await inventoryRepository.hasMovementForReference('ing-1', 'txn-1', 'sale_deduction');

    expect(prisma.inventoryMovement.findFirst).toHaveBeenCalledWith({
      where: { ingredientId: 'ing-1', referenceId: 'txn-1', movementType: 'sale_deduction' },
      select: { id: true },
    });
    expect(result).toBe(true);
  });

  it('returns false when no such movement exists', async () => {
    vi.mocked(prisma.inventoryMovement.findFirst).mockResolvedValue(null);

    const result = await inventoryRepository.hasMovementForReference('ing-1', 'txn-1', 'sale_deduction');

    expect(result).toBe(false);
  });
});

describe('inventoryRepository.updateTransactionDeductionStatus', () => {
  it('updates the transaction row inventoryDeductionStatus field', async () => {
    vi.mocked(prisma.transaction.update).mockResolvedValue({ id: 'txn-1', inventoryDeductionStatus: 'completed' } as never);

    await inventoryRepository.updateTransactionDeductionStatus('txn-1', 'completed');

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { inventoryDeductionStatus: 'completed' },
    });
  });
});

describe('inventoryRepository.findMovements', () => {
  it('scopes to the branch, applies pagination, and runs the count query in parallel', async () => {
    vi.mocked(prisma.inventoryMovement.findMany).mockResolvedValue([{ id: 'mov-1' }] as never);
    vi.mocked(prisma.inventoryMovement.count).mockResolvedValue(1);

    const result = await inventoryRepository.findMovements('branch-1', { page: 2, limit: 10 });

    expect(prisma.inventoryMovement.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1' },
      include: { ingredient: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(prisma.inventoryMovement.count).toHaveBeenCalledWith({ where: { branchId: 'branch-1' } });
    expect(result).toEqual({ movements: [{ id: 'mov-1' }], total: 1 });
  });

  it('adds ingredientId, movementType, and date-range filters to the where clause when provided', async () => {
    vi.mocked(prisma.inventoryMovement.findMany).mockResolvedValue([]);
    vi.mocked(prisma.inventoryMovement.count).mockResolvedValue(0);
    const fromDate = new Date('2026-01-01');
    const toDate = new Date('2026-01-31');

    await inventoryRepository.findMovements('branch-1', {
      ingredientId: 'ing-1',
      movementType: 'waste',
      fromDate,
      toDate,
      page: 1,
      limit: 25,
    });

    expect(prisma.inventoryMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branchId: 'branch-1',
          ingredientId: 'ing-1',
          movementType: 'waste',
          createdAt: { gte: fromDate, lte: toDate },
        },
      }),
    );
  });
});
