import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    transaction: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    transactionItem: { groupBy: vi.fn() },
    branch: { findMany: vi.fn(), findUnique: vi.fn() },
    shift: { findMany: vi.fn(), count: vi.fn() },
    inventoryMovement: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), count: vi.fn() },
    fraudAlert: { findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
    productVariant: { findMany: vi.fn() },
    flavor: { findMany: vi.fn() },
    ingredient: { findMany: vi.fn() },
    reportSnapshot: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { reportsRepository } = await import('./reports.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const baseFilters = { page: 1, limit: 25 } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportsRepository.getDailySales', () => {
  it('buckets completed/voided/refunded transactions by report_date and branch', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', totalAmount: decimal(112), discountAmount: decimal(0), vatAmount: decimal(12), createdAt: new Date('2026-07-01T10:00:00.000Z') },
      { branchId: 'b1', status: 'voided', totalAmount: decimal(50), discountAmount: decimal(0), vatAmount: decimal(5), createdAt: new Date('2026-07-01T11:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([
      {
        report_date: '2026-07-01',
        branch_id: 'b1',
        branch_name: 'SM North',
        gross_sales: 112,
        discount_total: 0,
        vat_total: 12,
        net_sales: 100,
        completed_count: 1,
        voided_count: 1,
        refunded_count: 0,
      },
    ]);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }),
    );
  });
});

describe('reportsRepository.getShiftSummary', () => {
  it('maps pre-computed Shift fields directly, without recomputing totals', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      {
        id: 'shift-1', branchId: 'b1', cashierId: 'u1', status: 'closed',
        startedAt: new Date('2026-07-01T08:00:00.000Z'), closedAt: new Date('2026-07-01T16:00:00.000Z'),
        openingCashAmount: decimal(1000), closingCashAmount: decimal(1500), expectedClosingCash: decimal(1500),
        cashVariance: decimal(0), varianceApproved: null, cashSalesTotal: decimal(400), gcashSalesTotal: decimal(100),
        totalTransactionCount: 10, voidedCount: 1, refundedCount: 0, totalDiscountAmount: decimal(20), pwdScTransactionCount: 2,
        branch: { name: 'SM North' }, cashier: { firstName: 'Juan', lastName: 'Cruz' },
      },
    ] as never);

    const [row] = await reportsRepository.getShiftSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(row).toMatchObject({ shift_id: 'shift-1', cashier_name: 'Juan Cruz', branch_name: 'SM North', total_transaction_count: 10 });
  });
});

describe('reportsRepository.getVoidRefund', () => {
  it('filters to voided/refunded statuses only', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

    await reportsRepository.getVoidRefund(baseFilters);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ['voided', 'refunded'] } }) }),
    );
  });
});

describe('reportsRepository.getDiscountCompliance', () => {
  it('groups by branch and discount type, excluding null discount_type', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { branchId: 'b1', discountType: 'pwd', _count: { _all: 3 }, _sum: { discountAmount: decimal(60), vatExemptAmount: decimal(30) } },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getDiscountCompliance(baseFilters);

    expect(rows).toEqual([{ branch_id: 'b1', branch_name: 'SM North', discount_type: 'pwd', transaction_count: 3, total_discount_amount: 60, total_vat_exempt_amount: 30 }]);
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ discountType: { not: null } }) }),
    );
  });
});

describe('reportsRepository.getFraudAlertSummary', () => {
  it('returns [] gracefully when no alerts exist', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);

    const rows = await reportsRepository.getFraudAlertSummary(baseFilters);

    expect(rows).toEqual([]);
  });
});

describe('reportsRepository.getProductPerformance', () => {
  it('does the two-step query: completed transaction ids first, then groupBy TransactionItem', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([{ id: 'tx-1' }, { id: 'tx-2' }] as never);
    vi.mocked(prisma.transactionItem.groupBy).mockResolvedValue([
      { productVariantId: 'pv-1', _sum: { quantity: 5, lineTotal: decimal(250) }, _count: { id: 3 } },
    ] as never);
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([
      { id: 'pv-1', name: 'Regular', product: { name: 'Cheese Potato' } },
    ] as never);

    const rows = await reportsRepository.getProductPerformance({ branchId: 'b1', page: 1, limit: 25 });

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'completed', branchId: 'b1' }), select: { id: true } }),
    );
    expect(prisma.transactionItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ transactionId: { in: ['tx-1', 'tx-2'] } }) }),
    );
    expect(rows).toEqual([{ product_variant_id: 'pv-1', product_name: 'Cheese Potato', variant_name: 'Regular', units_sold: 5, gross_revenue: 250, transaction_count: 3 }]);
  });

  it('short-circuits to [] without calling groupBy when there are no completed transactions', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

    const rows = await reportsRepository.getProductPerformance({ page: 1, limit: 25 });

    expect(rows).toEqual([]);
    expect(prisma.transactionItem.groupBy).not.toHaveBeenCalled();
  });
});

describe('reportsRepository.getFlavorPerformance', () => {
  it('does the same two-step query pattern, grouping by flavorId', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([{ id: 'tx-1' }] as never);
    vi.mocked(prisma.transactionItem.groupBy).mockResolvedValue([
      { flavorId: 'fl-1', _sum: { quantity: 2, lineTotal: decimal(100) } },
    ] as never);
    vi.mocked(prisma.flavor.findMany).mockResolvedValue([{ id: 'fl-1', name: 'Sour Cream' }] as never);

    const rows = await reportsRepository.getFlavorPerformance({ page: 1, limit: 25 });

    expect(prisma.transactionItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['flavorId'], where: expect.objectContaining({ flavorId: { not: null } }) }),
    );
    expect(rows).toEqual([{ flavor_id: 'fl-1', flavor_name: 'Sour Cream', units_sold: 2, gross_revenue: 100 }]);
  });
});

describe('reportsRepository.getInventoryValuation', () => {
  it('derives current_stock from summed InventoryMovement.quantityChange, not Ingredient.currentStock', async () => {
    vi.mocked(prisma.ingredient.findMany).mockResolvedValue([
      { id: 'ing-1', name: 'Potato', branchId: 'b1', unit: 'kg', unitCost: decimal(50), lowStockThreshold: decimal(10), criticalThreshold: decimal(5) },
    ] as never);
    vi.mocked(prisma.inventoryMovement.groupBy).mockResolvedValue([{ ingredientId: 'ing-1', _sum: { quantityChange: decimal(20) } }] as never);

    const rows = await reportsRepository.getInventoryValuation({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([{ ingredient_id: 'ing-1', ingredient_name: 'Potato', branch_id: 'b1', unit: 'kg', current_stock: 20, unit_cost: 50, total_value: 1000, status: 'ok' }]);
  });
});

describe('reportsRepository.saveSnapshot', () => {
  it('writes a new ReportSnapshot row with the given payload and parameters', async () => {
    vi.mocked(prisma.reportSnapshot.create).mockResolvedValue({ id: 'snap-new' } as never);
    vi.mocked(prisma.reportSnapshot.deleteMany).mockResolvedValue({ count: 0 } as never);

    await reportsRepository.saveSnapshot('PRODUCT_PERFORMANCE', 'b1', [{ foo: 'bar' }], { branchId: 'b1' });

    expect(prisma.reportSnapshot.create).toHaveBeenCalledWith({
      data: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', payload: [{ foo: 'bar' }], parameters: { branchId: 'b1' } },
    });
  });

  it('deletes sibling snapshots for the same (reportType, branchId), keeping only the newly created row', async () => {
    vi.mocked(prisma.reportSnapshot.create).mockResolvedValue({ id: 'snap-new' } as never);
    vi.mocked(prisma.reportSnapshot.deleteMany).mockResolvedValue({ count: 2 } as never);

    await reportsRepository.saveSnapshot('PRODUCT_PERFORMANCE', 'b1', [{ foo: 'bar' }], { branchId: 'b1' });

    expect(prisma.reportSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1', id: { not: 'snap-new' } },
    });
  });

  it('scopes sibling deletion correctly for a null branchId (org-wide report type)', async () => {
    vi.mocked(prisma.reportSnapshot.create).mockResolvedValue({ id: 'snap-new' } as never);
    vi.mocked(prisma.reportSnapshot.deleteMany).mockResolvedValue({ count: 1 } as never);

    await reportsRepository.saveSnapshot('BRANCH_COMPARISON', null, [], {});

    expect(prisma.reportSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { reportType: 'BRANCH_COMPARISON', branchId: null, id: { not: 'snap-new' } },
    });
  });
});

describe('reportsRepository.getLatestSnapshot', () => {
  it('returns null when no snapshots exist', async () => {
    vi.mocked(prisma.reportSnapshot.findFirst).mockResolvedValue(null);

    const result = await reportsRepository.getLatestSnapshot('PRODUCT_PERFORMANCE', 'b1');

    expect(result).toBeNull();
  });

  it('orders by computedAt desc to return the most recent snapshot', async () => {
    vi.mocked(prisma.reportSnapshot.findFirst).mockResolvedValue({ id: 'snap-2' } as never);

    await reportsRepository.getLatestSnapshot('PRODUCT_PERFORMANCE', 'b1');

    expect(prisma.reportSnapshot.findFirst).toHaveBeenCalledWith({
      where: { reportType: 'PRODUCT_PERFORMANCE', branchId: 'b1' },
      orderBy: { computedAt: 'desc' },
    });
  });
});

describe('reportsRepository.countRows', () => {
  it('dispatches VOID_REFUND to a direct transaction.count with the matching where clause', async () => {
    vi.mocked(prisma.transaction.count).mockResolvedValue(7);

    const count = await reportsRepository.countRows('VOID_REFUND', { branchId: 'b1', page: 1, limit: 25 });

    expect(count).toBe(7);
    expect(prisma.transaction.count).toHaveBeenCalledWith({ where: expect.objectContaining({ status: { in: ['voided', 'refunded'] }, branchId: 'b1' }) });
  });

  it('dispatches INVENTORY_MOVEMENT to inventoryMovement.count', async () => {
    vi.mocked(prisma.inventoryMovement.count).mockResolvedValue(3);

    const count = await reportsRepository.countRows('INVENTORY_MOVEMENT', { page: 1, limit: 25 });

    expect(count).toBe(3);
  });
});
