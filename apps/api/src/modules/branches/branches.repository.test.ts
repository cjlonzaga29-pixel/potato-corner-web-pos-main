import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    branch: { findMany: vi.fn(), delete: vi.fn() },
    shift: { groupBy: vi.fn(), count: vi.fn() },
    userBranchAssignment: { groupBy: vi.fn(), count: vi.fn() },
    transaction: { groupBy: vi.fn(), aggregate: vi.fn() },
    transactionItem: { findMany: vi.fn() },
    attendanceRecord: { groupBy: vi.fn(), count: vi.fn() },
    expense: { groupBy: vi.fn(), aggregate: vi.fn() },
    ingredient: { findMany: vi.fn() },
    inventoryStock: { findMany: vi.fn() },
    inventoryItem: { findMany: vi.fn() },
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

const EMPTY_PAYMENT_BREAKDOWN = {
  cash: { total: 0, count: 0 },
  gcash: { total: 0, count: 0 },
  maya: { total: 0, count: 0 },
  other: { total: 0, count: 0 },
};

/**
 * Narrow shape actually read by the dispatch logic below — real args are
 * Prisma.Transaction{GroupBy,Aggregate}Args. Prisma's groupBy/aggregate
 * methods are generic overloaded signatures whose Parameters<T> don't
 * resolve to a plain function type, so mockImplementation can't be typed
 * directly against `typeof prisma.transaction.groupBy` — the mocks are
 * asserted to this narrow, non-overloaded Mock type instead.
 */
interface TransactionQueryArgs {
  by?: string[];
  where?: { status?: string };
}

function asGroupByMock(fn: unknown): Mock<(args: TransactionQueryArgs) => Promise<unknown[]>> {
  return fn as unknown as Mock<(args: TransactionQueryArgs) => Promise<unknown[]>>;
}

function asAggregateMock(fn: unknown): Mock<(args: TransactionQueryArgs) => Promise<unknown>> {
  return fn as unknown as Mock<(args: TransactionQueryArgs) => Promise<unknown>>;
}

/** transaction.groupBy backs three different queries in this module — dispatch on shape instead of call order. */
function mockTransactionGroupBy(rows: {
  txn?: unknown[];
  refund?: unknown[];
  payment?: unknown[];
}) {
  asGroupByMock(prisma.transaction.groupBy).mockImplementation(async (args) => {
    if (args.by?.includes('paymentMethod')) return rows.payment ?? [];
    if (args.where?.status === 'refunded') return rows.refund ?? [];
    return rows.txn ?? [];
  });
}

/** transaction.aggregate backs both the completed-sales and refund-total queries. */
function mockTransactionAggregate(completed: unknown, refund: unknown) {
  asAggregateMock(prisma.transaction.aggregate).mockImplementation(async (args) => {
    if (args.where?.status === 'refunded') return refund;
    return completed;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.shift.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.shift.count).mockResolvedValue(0);
  vi.mocked(prisma.userBranchAssignment.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.userBranchAssignment.count).mockResolvedValue(0);
  vi.mocked(prisma.attendanceRecord.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0);
  mockTransactionGroupBy({});
  mockTransactionAggregate(
    { _count: { _all: 0 }, _sum: { subtotal: null, discountAmount: null, vatAmount: null } },
    { _sum: { totalAmount: null } },
  );
  vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.expense.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);
  vi.mocked(prisma.ingredient.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([] as never);
  vi.mocked(inventoryRepository.getCurrentStockMap).mockResolvedValue(new Map());
});

describe('branchesRepository.findAllStatsGrouped', () => {
  it('REGRESSION: returns a row for every active branch even when it has zero activity', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows).toEqual([
      {
        branchId: 'branch-1',
        activeShiftsCount: 0,
        activeStaffCount: 0,
        staffTimedInCount: 0,
        todayTransactionCount: 0,
        todayGrossSales: 0,
        todayDiscountTotal: 0,
        todayRefundTotal: 0,
        todayNetSales: 0,
        todayVat: 0,
        todayCogs: 0,
        todayGrossProfit: 0,
        todayExpenses: 0,
        todayNetProfit: 0,
        isNetProfitEstimated: false,
        missingCostItemCount: 0,
        paymentBreakdown: EMPTY_PAYMENT_BREAKDOWN,
        lowStockIngredientCount: 0,
      },
      {
        branchId: 'branch-2',
        activeShiftsCount: 0,
        activeStaffCount: 0,
        staffTimedInCount: 0,
        todayTransactionCount: 0,
        todayGrossSales: 0,
        todayDiscountTotal: 0,
        todayRefundTotal: 0,
        todayNetSales: 0,
        todayVat: 0,
        todayCogs: 0,
        todayGrossProfit: 0,
        todayExpenses: 0,
        todayNetProfit: 0,
        isNetProfitEstimated: false,
        missingCostItemCount: 0,
        paymentBreakdown: EMPTY_PAYMENT_BREAKDOWN,
        lowStockIngredientCount: 0,
      },
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

  it('correctly aggregates staffTimedInCount from attendanceRecord groupBy (currently clocked-in staff)', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.attendanceRecord.groupBy).mockResolvedValue([{ branchId: 'branch-1', _count: { _all: 3 } }] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ staffTimedInCount: 3 });
    expect(prisma.attendanceRecord.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clockOutServerTime: null, deletedAt: null } }),
    );
  });

  it('correctly aggregates todayGrossSales from txnGroups._sum.subtotal (not totalAmount)', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    mockTransactionGroupBy({
      txn: [{ branchId: 'branch-1', _sum: { subtotal: decimal(1234.56), discountAmount: decimal(0), vatAmount: decimal(0) }, _count: { _all: 9 } }],
    });

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ todayGrossSales: 1234.56, todayTransactionCount: 9 });
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

  it('computes Net Sales / Gross Profit / Net Profit per branch using the shared financial-metrics formula (no VAT double-subtraction)', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    mockTransactionGroupBy({
      txn: [
        {
          branchId: 'branch-1',
          _sum: { subtotal: decimal(1120), discountAmount: decimal(20), vatAmount: decimal(120) },
          _count: { _all: 5 },
        },
      ],
      refund: [{ branchId: 'branch-1', _sum: { totalAmount: decimal(100) } }],
    });
    vi.mocked(prisma.expense.groupBy).mockResolvedValue([{ branchId: 'branch-1', _sum: { amount: decimal(300) } }] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    // grossSales 1120, discount 20, refund 100 -> netSales 1000; cogs 0 (no items) -> grossProfit 1000; expenses 300 -> netProfit 700
    expect(rows[0]).toMatchObject({
      todayGrossSales: 1120,
      todayDiscountTotal: 20,
      todayRefundTotal: 100,
      todayNetSales: 1000,
      todayVat: 120,
      todayCogs: 0,
      todayGrossProfit: 1000,
      todayExpenses: 300,
      todayNetProfit: 700,
      isNetProfitEstimated: false,
    });
  });

  it('marks isNetProfitEstimated and missingCostItemCount when a branch has sold items with no resolvable cost', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([
      { deductionSnapshot: null, transaction: { branchId: 'branch-1' } },
    ] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({ isNetProfitEstimated: true, missingCostItemCount: 1, todayCogs: 0 });
  });

  it('builds a per-branch payment breakdown from paymentMethod groupBy rows, defaulting untouched methods to zero', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }] as never);
    mockTransactionGroupBy({
      payment: [
        { branchId: 'branch-1', paymentMethod: 'cash', _sum: { totalAmount: decimal(500) }, _count: { _all: 3 } },
        { branchId: 'branch-1', paymentMethod: 'gcash', _sum: { totalAmount: decimal(200) }, _count: { _all: 1 } },
      ],
    });

    const rows = await branchesRepository.findAllStatsGrouped();

    expect(rows[0]).toMatchObject({
      paymentBreakdown: {
        cash: { total: 500, count: 3 },
        gcash: { total: 200, count: 1 },
        maya: { total: 0, count: 0 },
        other: { total: 0, count: 0 },
      },
    });
  });

  it('does not leak one branch\'s transactions/items/expenses into another branch\'s totals (no double counting)', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }] as never);
    mockTransactionGroupBy({
      txn: [
        { branchId: 'branch-1', _sum: { subtotal: decimal(1000), discountAmount: decimal(0), vatAmount: decimal(0) }, _count: { _all: 1 } },
        { branchId: 'branch-2', _sum: { subtotal: decimal(2000), discountAmount: decimal(0), vatAmount: decimal(0) }, _count: { _all: 1 } },
      ],
    });
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([
      { deductionSnapshot: [{ inventoryItemId: 'i1', quantity: 1, componentCost: 40 }], transaction: { branchId: 'branch-1' } },
      { deductionSnapshot: [{ inventoryItemId: 'i2', quantity: 1, componentCost: 900 }], transaction: { branchId: 'branch-2' } },
    ] as never);
    vi.mocked(prisma.expense.groupBy).mockResolvedValue([
      { branchId: 'branch-1', _sum: { amount: decimal(50) } },
      { branchId: 'branch-2', _sum: { amount: decimal(75) } },
    ] as never);

    const rows = await branchesRepository.findAllStatsGrouped();

    const branch1 = rows.find((r) => r.branchId === 'branch-1');
    const branch2 = rows.find((r) => r.branchId === 'branch-2');

    expect(branch1).toMatchObject({ todayGrossSales: 1000, todayCogs: 40, todayExpenses: 50, todayNetProfit: 910 });
    expect(branch2).toMatchObject({ todayGrossSales: 2000, todayCogs: 900, todayExpenses: 75, todayNetProfit: 1025 });

    // Consolidated admin total should equal the plain sum of the two branch rows, not double-count either.
    const totalNetSales = rows.reduce((sum, r) => sum + r.todayNetSales, 0);
    expect(totalNetSales).toBe(3000);
  });
});

describe('branchesRepository.branchStats', () => {
  it('returns todayExpenses correctly for a branch with logged expenses today', async () => {
    mockTransactionAggregate(
      { _count: { _all: 3 }, _sum: { subtotal: decimal(1120), discountAmount: decimal(0), vatAmount: decimal(120) } },
      { _sum: { totalAmount: null } },
    );
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: decimal(250) } } as never);

    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats.todayExpenses).toBe(250);
  });

  it('returns todayExpenses = 0 for a branch with no expenses today', async () => {
    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats.todayExpenses).toBe(0);
  });

  it('computes Net Sales / Gross Profit / Net Profit using the shared financial-metrics formula (no VAT double-subtraction)', async () => {
    mockTransactionAggregate(
      { _count: { _all: 5 }, _sum: { subtotal: decimal(1120), discountAmount: decimal(20), vatAmount: decimal(120) } },
      { _sum: { totalAmount: decimal(100) } },
    );
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: decimal(300) } } as never);

    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats.todayGrossSales).toBe(1120);
    expect(stats.todayDiscountTotal).toBe(20);
    expect(stats.todayRefundTotal).toBe(100);
    expect(stats.todayNetSales).toBe(1000);
    expect(stats.todayVat).toBe(120);
    expect(stats.todayCogs).toBe(0);
    expect(stats.todayGrossProfit).toBe(1000);
    expect(stats.todayNetProfit).toBe(700);
    expect(stats.isNetProfitEstimated).toBe(false);
    expect(stats.missingCostItemCount).toBe(0);
  });

  it('surfaces staffTimedInCount from attendanceRecord.count scoped to the branch', async () => {
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(4);

    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats.staffTimedInCount).toBe(4);
    expect(prisma.attendanceRecord.count).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', clockOutServerTime: null, deletedAt: null },
    });
  });

  it('flags isNetProfitEstimated and reports missingCostItemCount when a sold item has no resolvable cost, rather than silently treating COGS as zero', async () => {
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([{ deductionSnapshot: null }] as never);

    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats.isNetProfitEstimated).toBe(true);
    expect(stats.missingCostItemCount).toBe(1);
  });

  it('builds a payment-method breakdown of today\'s completed sales, keyed by cash/gcash/maya/other', async () => {
    mockTransactionGroupBy({
      payment: [
        { paymentMethod: 'cash', _sum: { totalAmount: decimal(300) }, _count: { _all: 2 } },
        { paymentMethod: 'maya', _sum: { totalAmount: decimal(150) }, _count: { _all: 1 } },
      ],
    });

    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats.paymentBreakdown).toEqual({
      cash: { total: 300, count: 2 },
      gcash: { total: 0, count: 0 },
      maya: { total: 150, count: 1 },
      other: { total: 0, count: 0 },
    });
  });

  it('no longer returns a duplicate todayRevenue field (Simple Operational Audit §4)', async () => {
    const stats = await branchesRepository.branchStats('branch-1');

    expect(stats).not.toHaveProperty('todayRevenue');
  });
});

describe('branchesRepository.delete', () => {
  it('deletes the branch by id', async () => {
    vi.mocked(prisma.branch.delete).mockResolvedValue({ id: 'branch-1' } as never);

    await branchesRepository.delete('branch-1');

    expect(prisma.branch.delete).toHaveBeenCalledWith({ where: { id: 'branch-1' } });
  });
});
