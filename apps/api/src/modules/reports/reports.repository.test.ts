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
    inventoryStock: { findMany: vi.fn() },
    inventoryItem: { count: vi.fn() },
    inventoryStockMovement: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    unitOfMeasure: { findUnique: vi.fn() },
    reportSnapshot: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
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
      { branchId: 'b1', status: 'completed', subtotal: decimal(112), totalAmount: decimal(112), discountAmount: decimal(0), vatAmount: decimal(12), createdAt: new Date('2026-07-01T10:00:00.000Z') },
      { branchId: 'b1', status: 'voided', subtotal: decimal(50), totalAmount: decimal(50), discountAmount: decimal(0), vatAmount: decimal(5), createdAt: new Date('2026-07-01T11:00:00.000Z') },
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
        net_sales: 112,
        completed_count: 1,
        voided_count: 1,
        refunded_count: 0,
      },
    ]);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }),
    );
  });

  it('computes net_sales via computeFinancialMetrics (gross - discounts - refunds, no VAT subtraction) to match branchStats.todayNetSales for the same branch/day', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', subtotal: decimal(200), totalAmount: decimal(160), discountAmount: decimal(40), vatAmount: decimal(17.14), createdAt: new Date('2026-07-01T10:00:00.000Z') },
      { branchId: 'b1', status: 'refunded', subtotal: decimal(100), totalAmount: decimal(100), discountAmount: decimal(0), vatAmount: decimal(10.71), createdAt: new Date('2026-07-01T12:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const [row] = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    // gross_sales(200) - discount_total(40) - refund_total(100) = 60 — the
    // refunded transaction's totalAmount(100) is subtracted even though it
    // never contributed to gross_sales/discount_total (only completed rows
    // do), and VAT is never subtracted a second time (per financial-metrics.ts).
    expect(row).toMatchObject({ gross_sales: 200, discount_total: 40, net_sales: 60, refunded_count: 1 });
  });

  it('buckets a transaction just after UTC midnight into the Manila business day already in progress', async () => {
    // 2026-07-01T00:30:00.000Z == 2026-07-01T08:30:00+08:00 -> still July 1 in Manila,
    // but toISOString().slice(0, 10) on the raw UTC value would also read "2026-07-01"
    // here — the regression this guards is the *other* direction, tested below.
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', subtotal: decimal(112), totalAmount: decimal(112), discountAmount: decimal(0), vatAmount: decimal(12), createdAt: new Date('2026-06-30T20:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    // 2026-06-30T20:00:00.000Z == 2026-07-01T04:00:00+08:00 -> Manila July 1,
    // even though the UTC calendar date is still June 30.
    expect(rows[0]?.report_date).toBe('2026-07-01');
  });

  it('reports gross_sales as the pre-discount subtotal, not the post-discount totalAmount', async () => {
    // A PWD/Senior sale: subtotal 200, 20% discount = 40, totalAmount 160.
    // gross_sales must read 200 (matching lib/financial-metrics.ts's grossSales
    // definition, which every dashboard KPI card is built from) — reporting 160
    // here would silently understate Gross Sales on Reports/Sales Trend/Branch
    // Comparison relative to the Admin/Supervisor/Branch dashboard KPI cards.
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', subtotal: decimal(200), totalAmount: decimal(160), discountAmount: decimal(40), vatAmount: decimal(0), createdAt: new Date('2026-07-01T10:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const [row] = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    expect(row?.gross_sales).toBe(200);
    expect(row?.discount_total).toBe(40);
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

describe('reportsRepository.getPaymentMethodMix', () => {
  it('groups completed transactions by payment method', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { paymentMethod: 'cash', _count: { _all: 4 }, _sum: { totalAmount: decimal(400) } },
      { paymentMethod: 'gcash', _count: { _all: 2 }, _sum: { totalAmount: decimal(200) } },
    ] as never);

    const rows = await reportsRepository.getPaymentMethodMix(baseFilters);

    expect(rows).toEqual([
      { payment_method: 'cash', transaction_count: 4, total_amount: 400 },
      { payment_method: 'gcash', transaction_count: 2, total_amount: 200 },
    ]);
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['paymentMethod'], where: expect.objectContaining({ status: 'completed' }) }),
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

describe('reportsRepository.getInventoryMovement', () => {
  it('reads InventoryStockMovement/InventoryItem, not the legacy InventoryMovement/Ingredient tables', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        id: 'mv-1',
        branchId: 'b1',
        inventoryItemId: 'item-1',
        movementType: 'SALE',
        quantityChange: decimal(-2),
        quantityBefore: decimal(10),
        quantityAfter: decimal(8),
        referenceType: 'delivery',
        referenceId: 'ref-1',
        notes: 'Received from supplier',
        performedByUserId: 'u1',
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Potato' },
        unit: { code: 'kg' },
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u1', firstName: 'Juan', lastName: 'Cruz' }] as never);

    const rows = await reportsRepository.getInventoryMovement({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([
      {
        movement_id: 'mv-1',
        branch_id: 'b1',
        branch_name: 'SM North',
        ingredient_id: 'item-1',
        ingredient_name: 'Potato',
        unit: 'kg',
        movement_type: 'SALE',
        quantity_change: -2,
        quantity_before: 10,
        quantity_after: 8,
        reference_type: 'delivery',
        reference_id: 'ref-1',
        notes: 'Received from supplier',
        recorded_by_name: 'Juan Cruz',
        created_at: '2026-07-01T10:00:00.000Z',
      },
    ]);
    expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
  });

  it('falls back to em-dash for unit when the movement has no unitId, mirroring the Inventory Movement screen', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        id: 'mv-2', branchId: 'b1', inventoryItemId: 'item-1', movementType: 'WASTE',
        quantityChange: decimal(-1), quantityBefore: decimal(5), quantityAfter: decimal(4),
        referenceType: null, referenceId: null, notes: null,
        performedByUserId: null, createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato' }, unit: null,
      },
    ] as never);

    const rows = await reportsRepository.getInventoryMovement({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]?.unit).toBe('—');
  });

  it('respects the branchId filter, date range, pagination and createdAt desc ordering', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([]);

    await reportsRepository.getInventoryMovement({
      branchId: 'b1',
      dateFrom: new Date('2026-07-01T00:00:00.000Z'),
      dateTo: new Date('2026-07-31T23:59:59.999Z'),
      page: 2,
      limit: 10,
    });

    expect(prisma.inventoryStockMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: 'b1',
          createdAt: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-31T23:59:59.999Z') },
        }),
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
  });

  it('leaves recorded_by_name null without querying users when performedByUserId is null', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        id: 'mv-1', branchId: 'b1', inventoryItemId: 'item-1', movementType: 'PHYSICAL_COUNT',
        quantityChange: decimal(0), quantityBefore: decimal(10), quantityAfter: decimal(10),
        referenceType: null, referenceId: null, notes: null,
        performedByUserId: null, createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato' }, unit: { code: 'kg' },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryMovement(baseFilters);

    expect(rows[0]?.recorded_by_name).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('reportsRepository.getInventorySummary', () => {
  it('returns [] without querying movements when the branch has no stock rows', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([]);

    const rows = await reportsRepository.getInventorySummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([]);
    expect(prisma.inventoryStockMovement.groupBy).not.toHaveBeenCalled();
  });

  it('derives opening_stock by subtracting today\'s net movement from the current balance, and sums SALE-only movements for consumed_today/consumed_this_month', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-1',
        quantityOnHand: decimal(7),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Flour', baseUnitId: 'unit-kg', baseUnit: { code: 'kg', dimension: 'WEIGHT' } },
      },
    ] as never);
    // Today: a stock_in of +2 and a sale of -5 net to -3 -> opening = 7 - (-3) = 10.
    vi.mocked(prisma.inventoryStockMovement.groupBy)
      .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-1', _sum: { quantityChange: decimal(-3) } }] as never)
      .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-1', _sum: { quantityChange: decimal(-5) } }] as never)
      .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-1', _sum: { quantityChange: decimal(-40) } }] as never);
    vi.mocked(prisma.unitOfMeasure.findUnique)
      .mockResolvedValueOnce({ id: 'unit-g', code: 'g' } as never)
      .mockResolvedValueOnce({ id: 'unit-kg', code: 'kg' } as never);

    const rows = await reportsRepository.getInventorySummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([
      {
        ingredient_id: 'item-1',
        ingredient_name: 'Flour',
        branch_id: 'b1',
        branch_name: 'SM North',
        unit: 'kg',
        opening_stock: 10,
        consumed_today: 5,
        consumed_this_month: 40,
        remaining_stock: 7,
        remaining_grams: 7000,
        remaining_kilograms: 7,
      },
    ]);
  });

  it('returns null grams/kilograms for a non-weight unit instead of fabricating a conversion', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-2',
        quantityOnHand: decimal(12),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Cups', baseUnitId: 'unit-pc', baseUnit: { code: 'pc', dimension: 'COUNT' } },
      },
    ] as never);
    vi.mocked(prisma.inventoryStockMovement.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.unitOfMeasure.findUnique)
      .mockResolvedValueOnce({ id: 'unit-g', code: 'g' } as never)
      .mockResolvedValueOnce({ id: 'unit-kg', code: 'kg' } as never);

    const rows = await reportsRepository.getInventorySummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]).toMatchObject({ unit: 'pc', opening_stock: 12, consumed_today: 0, remaining_grams: null, remaining_kilograms: null });
  });

  it('scopes InventoryStock.findMany to the given branchId', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([]);

    await reportsRepository.getInventorySummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(prisma.inventoryStock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }),
    );
  });
});

describe('reportsRepository.getInventoryValuation', () => {
  it('derives current_stock from InventoryStock.quantityOnHand, not Ingredient/InventoryMovement', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-1',
        quantityOnHand: decimal(20),
        lowStockThreshold: decimal(10),
        criticalThreshold: decimal(5),
        unitCost: decimal(50),
        inventoryItem: { name: 'Potato', unitCost: null, baseUnit: { code: 'kg' } },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryValuation({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([{ ingredient_id: 'item-1', ingredient_name: 'Potato', branch_id: 'b1', unit: 'kg', current_stock: 20, unit_cost: 50, total_value: 1000, status: 'ok' }]);
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.groupBy).not.toHaveBeenCalled();
  });

  it('maps low/critical InventoryStock thresholds to the ok/low/critical status literal', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      { branchId: 'b1', inventoryItemId: 'item-low', quantityOnHand: decimal(8), lowStockThreshold: decimal(10), criticalThreshold: decimal(5), unitCost: decimal(1), inventoryItem: { name: 'Cheese', unitCost: null, baseUnit: { code: 'kg' } } },
      { branchId: 'b1', inventoryItemId: 'item-crit', quantityOnHand: decimal(2), lowStockThreshold: decimal(10), criticalThreshold: decimal(5), unitCost: decimal(1), inventoryItem: { name: 'Ketchup', unitCost: null, baseUnit: { code: 'L' } } },
    ] as never);

    const rows = await reportsRepository.getInventoryValuation({ page: 1, limit: 25 });

    expect(rows.find((r) => r.ingredient_id === 'item-low')?.status).toBe('low');
    expect(rows.find((r) => r.ingredient_id === 'item-crit')?.status).toBe('critical');
  });
});

describe('reportsRepository.getInventoryValuationRollup', () => {
  function stockRow(overrides: {
    branchId: string;
    quantityOnHand: number;
    stockUnitCost?: number | null;
    itemUnitCost?: number | null;
    lowStockThreshold?: number | null;
    criticalThreshold?: number | null;
  }) {
    return {
      branchId: overrides.branchId,
      quantityOnHand: decimal(overrides.quantityOnHand),
      lowStockThreshold: overrides.lowStockThreshold != null ? decimal(overrides.lowStockThreshold) : null,
      criticalThreshold: overrides.criticalThreshold != null ? decimal(overrides.criticalThreshold) : null,
      unitCost: overrides.stockUnitCost != null ? decimal(overrides.stockUnitCost) : null,
      inventoryItem: { unitCost: overrides.itemUnitCost != null ? decimal(overrides.itemUnitCost) : null },
    };
  }

  beforeEach(() => {
    vi.mocked(prisma.inventoryStockMovement.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.inventoryItem.count).mockResolvedValue(0 as never);
  });

  it('TEST A: 500 pcs of Large Cup at $0.08 unit cost values at $40.00', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      stockRow({ branchId: 'b1', quantityOnHand: 500, itemUnitCost: 0.08 }),
    ] as never);
    vi.mocked(prisma.inventoryItem.count).mockResolvedValue(1 as never);

    const result = await reportsRepository.getInventoryValuationRollup();

    expect(result.branches).toEqual([
      expect.objectContaining({ branch_id: 'b1', branch_name: 'SM North', inventory_item_count: 1, total_inventory_value: 40 }),
    ]);
    expect(result.summary.total_inventory_value).toBe(40);
  });

  it('TEST B: sums branch totals into the admin summary total across multiple branches', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([
      { id: 'b1', name: 'Branch A' },
      { id: 'b2', name: 'Branch B' },
    ] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      stockRow({ branchId: 'b1', quantityOnHand: 500, itemUnitCost: 0.08 }),
      stockRow({ branchId: 'b2', quantityOnHand: 1000, itemUnitCost: 0.08 }),
    ] as never);

    const result = await reportsRepository.getInventoryValuationRollup();

    const byBranch = new Map(result.branches.map((b) => [b.branch_id, b.total_inventory_value]));
    expect(byBranch.get('b1')).toBe(40);
    expect(byBranch.get('b2')).toBe(80);
    expect(result.summary.total_inventory_value).toBe(120);
  });

  it('TEST C: a zero-quantity stock row counts toward inventory_item_count with $0.00 value', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      stockRow({ branchId: 'b1', quantityOnHand: 0, itemUnitCost: 5 }),
    ] as never);

    const result = await reportsRepository.getInventoryValuationRollup();

    expect(result.branches[0]).toEqual(
      expect.objectContaining({ branch_id: 'b1', inventory_item_count: 1, total_inventory_value: 0, out_of_stock_count: 1 }),
    );
  });

  it('TEST D: healthy/low/critical/out-of-stock counts match the InventoryStock alert threshold rule', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      stockRow({ branchId: 'b1', quantityOnHand: 100, lowStockThreshold: 20, criticalThreshold: 5, itemUnitCost: 1 }), // healthy
      stockRow({ branchId: 'b1', quantityOnHand: 15, lowStockThreshold: 20, criticalThreshold: 5, itemUnitCost: 1 }), // low
      stockRow({ branchId: 'b1', quantityOnHand: 3, lowStockThreshold: 20, criticalThreshold: 5, itemUnitCost: 1 }), // critical
      stockRow({ branchId: 'b1', quantityOnHand: 0, lowStockThreshold: 20, criticalThreshold: 5, itemUnitCost: 1 }), // critical + out of stock
    ] as never);

    const result = await reportsRepository.getInventoryValuationRollup();

    expect(result.branches[0]).toEqual(
      expect.objectContaining({ low_stock_count: 1, critical_stock_count: 2, out_of_stock_count: 1 }),
    );
    expect(result.summary.total_low_stock_rows).toBe(1);
    expect(result.summary.total_critical_stock_rows).toBe(2);
    expect(result.summary.total_out_of_stock_rows).toBe(1);
  });

  it('TEST E: never reads the legacy Ingredient or InventoryMovement tables', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([stockRow({ branchId: 'b1', quantityOnHand: 10, itemUnitCost: 1 })] as never);

    await reportsRepository.getInventoryValuationRollup();

    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.groupBy).not.toHaveBeenCalled();
  });

  it('prefers InventoryStock.unit_cost over InventoryItem.unit_cost when a branch-specific override exists', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      stockRow({ branchId: 'b1', quantityOnHand: 10, stockUnitCost: 2, itemUnitCost: 1 }),
    ] as never);

    const result = await reportsRepository.getInventoryValuationRollup();

    expect(result.branches[0]?.total_inventory_value).toBe(20);
  });
});

describe('reportsRepository.getBranchComparison', () => {
  it('derives low_stock_ingredient_count from InventoryStock, not the legacy Ingredient/InventoryMovement tables', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { branchId: 'b1', _sum: { subtotal: decimal(500) }, _count: { _all: 5 } },
    ] as never);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([{ branchId: 'b1' }] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      { branchId: 'b1', quantityOnHand: decimal(3), lowStockThreshold: decimal(10) },
      { branchId: 'b1', quantityOnHand: decimal(50), lowStockThreshold: decimal(10) },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getBranchComparison(baseFilters);

    expect(rows).toEqual([
      { branch_id: 'b1', branch_name: 'SM North', gross_sales: 500, transaction_count: 5, active_shift_count: 1, low_stock_ingredient_count: 1 },
    ]);
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.groupBy).not.toHaveBeenCalled();
  });

  it('reports gross_sales from _sum.subtotal, not _sum.totalAmount, so a discounted sale is not understated', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { branchId: 'b1', _sum: { subtotal: decimal(200) }, _count: { _all: 1 } },
    ] as never);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getBranchComparison(baseFilters);

    expect(rows[0]?.gross_sales).toBe(200);
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith(expect.objectContaining({ _sum: { subtotal: true } }));
  });

  it('ignores stock rows with no low_stock_threshold configured', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      { branchId: 'b1', quantityOnHand: decimal(0), lowStockThreshold: null },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getBranchComparison(baseFilters);

    expect(rows[0]?.low_stock_ingredient_count).toBe(0);
  });
});

describe('reportsRepository.getEmployeePerformance', () => {
  it('reports gross_sales from _sum.subtotal, not _sum.totalAmount, so a discounted sale is not understated', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { cashierId: 'u1', branchId: 'b1', _sum: { subtotal: decimal(200) }, _count: { _all: 1 } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'u1', firstName: 'Juan', lastName: 'Cruz' }] as never);
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);

    const rows = await reportsRepository.getEmployeePerformance(baseFilters);

    expect(rows[0]?.gross_sales).toBe(200);
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith(expect.objectContaining({ _sum: { subtotal: true } }));
  });
});

describe('reportsRepository.getInventoryAnalytics', () => {
  const dateFrom = new Date('2026-06-23T00:00:00.000Z');
  const dateTo = new Date('2026-07-23T00:00:00.000Z');
  const stockRows = [
    { branchId: 'b1', inventoryItemId: 'item-fast', quantityOnHand: decimal(100), lowStockThreshold: decimal(10), unitCost: null, inventoryItem: { name: 'Potato', unitCost: decimal(5), baseUnit: { code: 'kg' } } },
    { branchId: 'b1', inventoryItemId: 'item-slow', quantityOnHand: decimal(50), lowStockThreshold: decimal(10), unitCost: null, inventoryItem: { name: 'Cheese Powder', unitCost: decimal(20), baseUnit: { code: 'kg' } } },
    { branchId: 'b1', inventoryItemId: 'item-low', quantityOnHand: decimal(5), lowStockThreshold: decimal(4), unitCost: null, inventoryItem: { name: 'Ketchup', unitCost: decimal(10), baseUnit: { code: 'L' } } },
  ];

  function mockPrismaCalls(overrides: {
    consumption?: unknown[];
    waste?: unknown[];
    lastMovement?: unknown[];
    reorderConsumption?: unknown[];
    stocks?: unknown[];
    branches?: unknown[];
    totalMovements?: number;
  }) {
    vi.mocked(prisma.inventoryStockMovement.groupBy)
      .mockResolvedValueOnce((overrides.consumption ?? []) as never)
      .mockResolvedValueOnce((overrides.lastMovement ?? []) as never)
      .mockResolvedValueOnce((overrides.reorderConsumption ?? []) as never);
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue((overrides.waste ?? []) as never);
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue((overrides.stocks ?? stockRows) as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue((overrides.branches ?? [{ id: 'b1', name: 'SM North' }]) as never);
    vi.mocked(prisma.inventoryStockMovement.count).mockResolvedValue((overrides.totalMovements ?? 0) as never);
  }

  it('returns fast movers ordered by consumption desc', async () => {
    mockPrismaCalls({
      consumption: [
        { inventoryItemId: 'item-slow', branchId: 'b1', _sum: { quantityChange: decimal(-5) } },
        { inventoryItemId: 'item-fast', branchId: 'b1', _sum: { quantityChange: decimal(-50) } },
      ],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.fast_movers.map((m) => m.ingredient_id)).toEqual(['item-fast', 'item-slow']);
    expect(result.fast_movers[0]).toMatchObject({ total_consumed: 50, avg_daily_consumption: 1.667 });
  });

  it('returns slow movers ordered by ascending consumption', async () => {
    mockPrismaCalls({
      consumption: [
        { inventoryItemId: 'item-fast', branchId: 'b1', _sum: { quantityChange: decimal(-50) } },
        { inventoryItemId: 'item-slow', branchId: 'b1', _sum: { quantityChange: decimal(-5) } },
      ],
      lastMovement: [{ inventoryItemId: 'item-slow', branchId: 'b1', _max: { createdAt: new Date('2026-07-10T00:00:00.000Z') } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.slow_movers.map((m) => m.ingredient_id)).toEqual(['item-slow', 'item-fast']);
    const slowest = result.slow_movers[0];
    expect(slowest).toBeDefined();
    expect(slowest?.days_since_last_movement).toBe(13);
  });

  it('computes waste trends grouped by Manila calendar day, not UTC day', async () => {
    mockPrismaCalls({
      waste: [
        // 2026-07-10T08:00:00Z == 2026-07-10T16:00+08:00 -> Manila July 10
        { inventoryItemId: 'item-fast', branchId: 'b1', quantityChange: decimal(-2), createdAt: new Date('2026-07-10T08:00:00.000Z') },
        // 2026-07-10T20:00:00Z == 2026-07-11T04:00+08:00 -> already Manila July 11,
        // even though the UTC calendar date is still the 10th.
        { inventoryItemId: 'item-fast', branchId: 'b1', quantityChange: decimal(-3), createdAt: new Date('2026-07-10T20:00:00.000Z') },
        { inventoryItemId: 'item-slow', branchId: 'b1', quantityChange: decimal(-1), createdAt: new Date('2026-07-11T08:00:00.000Z') },
      ],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.waste_trends).toEqual([
      // item-fast unitCost 5: only the 08:00Z entry (qty 2) is Manila July 10.
      { date: '2026-07-10', total_waste_quantity: 2, total_waste_cost: 10 },
      // The 20:00Z item-fast entry (qty 3, cost 15) rolls into Manila July 11
      // alongside item-slow's entry (qty 1, unitCost 20, cost 20).
      { date: '2026-07-11', total_waste_quantity: 4, total_waste_cost: 35 },
    ]);
  });

  it('computes turnover rate per branch', async () => {
    mockPrismaCalls({
      consumption: [{ inventoryItemId: 'item-fast', branchId: 'b1', _sum: { quantityChange: decimal(-10) } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    // consumed cost = 10 * 5 = 50; inventory value = 100*5 + 50*20 + 5*10 = 1550
    expect(result.turnover_by_branch).toEqual([
      { branch_id: 'b1', branch_name: 'SM North', turnover_rate: 0.032, total_consumed: 50, avg_inventory_value: 1550 },
    ]);
  });

  it('computes reorder recommendations with days until stockout', async () => {
    mockPrismaCalls({
      reorderConsumption: [{ inventoryItemId: 'item-low', branchId: 'b1', _sum: { quantityChange: decimal(-30) } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.reorder_recommendations).toHaveLength(1);
    expect(result.reorder_recommendations[0]).toMatchObject({ ingredient_id: 'item-low', current_stock: 5, avg_daily_consumption: 1, days_until_stockout: 5 });
  });

  it('respects branchId filter', async () => {
    mockPrismaCalls({ stocks: [stockRows[0]] });

    await reportsRepository.getInventoryAnalytics({ branchId: 'b1', dateFrom, dateTo, periodDays: 30 });

    expect(prisma.inventoryStock.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }));
    expect(prisma.inventoryStockMovement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }));
  });

  it('respects the period parameter when computing avg daily consumption', async () => {
    mockPrismaCalls({
      consumption: [{ inventoryItemId: 'item-fast', branchId: 'b1', _sum: { quantityChange: decimal(-90) } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 90 });

    const fastest = result.fast_movers[0];
    expect(fastest).toBeDefined();
    expect(fastest?.avg_daily_consumption).toBe(1);
  });

  it('returns empty structures gracefully with no data', async () => {
    mockPrismaCalls({ stocks: [] });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result).toEqual({
      fast_movers: [],
      slow_movers: [],
      waste_trends: [],
      turnover_by_branch: [],
      reorder_recommendations: [],
      summary: { total_movements: 0, total_waste_cost: 0, total_consumption_cost: 0, avg_turnover_rate: 0 },
    });
  });

  it('never reads the legacy Ingredient or InventoryMovement tables', async () => {
    mockPrismaCalls({});

    await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.groupBy).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.count).not.toHaveBeenCalled();
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

  it('dispatches INVENTORY_MOVEMENT to inventoryStockMovement.count, not the legacy inventoryMovement.count', async () => {
    vi.mocked(prisma.inventoryStockMovement.count).mockResolvedValue(3);

    const count = await reportsRepository.countRows('INVENTORY_MOVEMENT', { page: 1, limit: 25 });

    expect(count).toBe(3);
    expect(prisma.inventoryMovement.count).not.toHaveBeenCalled();
  });
});

describe('reportsRepository.getAuditLog', () => {
  function auditLogRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'audit-1',
      createdAt: new Date('2026-07-14T10:00:00.000Z'),
      action: 'LOGIN_SUCCESS',
      actorId: 'user-1',
      actorRole: 'staff',
      ipAddress: '127.0.0.1',
      ...overrides,
    };
  }

  it('filters to only the login-related and operational audit actions', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);

    await reportsRepository.getAuditLog(baseFilters);

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: {
            in: [
              'LOGIN_SUCCESS',
              'LOGIN_FAILURE',
              'LOGOUT',
              'LOGOUT_ALL_DEVICES',
              'PIN_LOGIN_SUCCESS',
              'ACCOUNT_UNLOCKED',
              'VOID_TRANSACTION',
              'REFUND_TRANSACTION',
            ],
          },
        }),
      }),
    );
  });

  it('applies the branchId filter when provided', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);

    await reportsRepository.getAuditLog({ branchId: 'b1', page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }),
    );
  });

  it('does not apply a branchId filter when none is provided', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);

    await reportsRepository.getAuditLog(baseFilters);

    const callArgs = vi.mocked(prisma.auditLog.findMany).mock.calls[0]?.[0];
    expect(callArgs?.where).not.toHaveProperty('branchId');
  });

  it('applies the date range filter via dateRangeFilter when dateFrom/dateTo are present', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);

    await reportsRepository.getAuditLog({ dateFrom: new Date('2026-07-01T00:00:00.000Z'), dateTo: new Date('2026-07-31T23:59:59.999Z'), page: 1, limit: 25 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-31T23:59:59.999Z') },
        }),
      }),
    );
  });

  it('returns the snake_case shape (created_at, actor_id, actor_role, ip_address)', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([auditLogRow()] as never);

    const rows = await reportsRepository.getAuditLog(baseFilters);

    expect(rows).toEqual([
      {
        id: 'audit-1',
        created_at: '2026-07-14T10:00:00.000Z',
        action: 'LOGIN_SUCCESS',
        actor_id: 'user-1',
        actor_role: 'staff',
        ip_address: '127.0.0.1',
      },
    ]);
  });

  it('respects pagination via filters.page and filters.limit', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);

    await reportsRepository.getAuditLog({ page: 3, limit: 10 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: (3 - 1) * 10, take: 10 }),
    );
  });

  it('orders by createdAt desc', async () => {
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);

    await reportsRepository.getAuditLog(baseFilters);

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });
});
