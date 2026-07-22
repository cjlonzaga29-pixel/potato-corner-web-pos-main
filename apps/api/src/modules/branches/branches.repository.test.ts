import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    branch: { findMany: vi.fn() },
    shift: { groupBy: vi.fn() },
    userBranchAssignment: { groupBy: vi.fn() },
    transaction: { groupBy: vi.fn() },
    ingredient: { findMany: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    getCurrentStockMap: vi.fn(),
  },
}));

const { prisma } = await import('../../lib/prisma.js');
const { inventoryRepository } = await import('../inventory/inventory.repository.js');
const { branchesRepository } = await import('./branches.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.shift.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.userBranchAssignment.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.transaction.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.ingredient.findMany).mockResolvedValue([] as never);
  vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(new Map());
});

describe('branchesRepository.findAllStatsGrouped', () => {
  it('REGRESSION: returns a row for every active branch even when it has zero shifts, zero staff, zero transactions, and zero low-stock ingredients', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows).toEqual([
      { branchId: 'branch-1', activeShiftsCount: 0, activeStaffCount: 0, todayRevenue: 0, todayTransactionCount: 0, lowStockIngredientCount: 0 },
      { branchId: 'branch-2', activeShiftsCount: 0, activeStaffCount: 0, todayRevenue: 0, todayTransactionCount: 0, lowStockIngredientCount: 0 },
    ]);
  });

  it('does NOT include branches with status !== active', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);

    await branchesRepository.findAllStatsGrouped();

    expect(prisma.branch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'active' } }));
  });

  it('correctly aggregates activeShiftsCount from shiftGroups', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.shift.groupBy).mockResolvedValue([{ branchId: 'branch-1', _count: { _all: 4 } }] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ activeShiftsCount: 4 });
  });

  it('correctly aggregates activeStaffCount from staffGroups', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.userBranchAssignment.groupBy).mockResolvedValue([{ branchId: 'branch-1', _count: { _all: 6 } }] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ activeStaffCount: 6 });
  });

  it('correctly aggregates todayRevenue from txnGroups._sum.totalAmount', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { branchId: 'branch-1', _sum: { totalAmount: decimal(1234.56) }, _count: { _all: 9 } },
    ] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ todayRevenue: 1234.56 });
  });

  it('correctly aggregates todayTransactionCount from txnGroups._count._all', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { branchId: 'branch-1', _sum: { totalAmount: decimal(100) }, _count: { _all: 9 } },
    ] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ todayTransactionCount: 9 });
  });

  it('lowStockIngredientCount reflects ingredients where current stock <= threshold', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.ingredient.findMany).mockResolvedValue([
      { id: 'ing-low', branchId: 'branch-1', lowStockThreshold: decimal(10) },
      { id: 'ing-ok', branchId: 'branch-1', lowStockThreshold: decimal(10) },
    ] as never);
    vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(
      new Map([
        ['ing-low', decimal(5)], // 5 <= 10 -> counts as low stock
        ['ing-ok', decimal(50)], // 50 > 10 -> does not count
      ]) as never,
    );

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ lowStockIngredientCount: 1 });
  });
});
