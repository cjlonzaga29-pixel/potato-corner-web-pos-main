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

describe('reportsRepository.getInventoryAnalytics', () => {
  const dateFrom = new Date('2026-06-23T00:00:00.000Z');
  const dateTo = new Date('2026-07-23T00:00:00.000Z');
  const ingredientRows = [
    { id: 'ing-fast', name: 'Potato', unit: 'kg', currentStock: decimal(100), lowStockThreshold: decimal(10), unitCost: decimal(5), branchId: 'b1' },
    { id: 'ing-slow', name: 'Cheese Powder', unit: 'kg', currentStock: decimal(50), lowStockThreshold: decimal(10), unitCost: decimal(20), branchId: 'b1' },
    { id: 'ing-low', name: 'Ketchup', unit: 'L', currentStock: decimal(5), lowStockThreshold: decimal(4), unitCost: decimal(10), branchId: 'b1' },
  ];

  function mockPrismaCalls(overrides: {
    consumption?: unknown[];
    waste?: unknown[];
    lastMovement?: unknown[];
    reorderConsumption?: unknown[];
    ingredients?: unknown[];
    branches?: unknown[];
    totalMovements?: number;
  }) {
    vi.mocked(prisma.inventoryMovement.groupBy)
      .mockResolvedValueOnce((overrides.consumption ?? []) as never)
      .mockResolvedValueOnce((overrides.lastMovement ?? []) as never)
      .mockResolvedValueOnce((overrides.reorderConsumption ?? []) as never);
    vi.mocked(prisma.inventoryMovement.findMany).mockResolvedValue((overrides.waste ?? []) as never);
    vi.mocked(prisma.ingredient.findMany).mockResolvedValue((overrides.ingredients ?? ingredientRows) as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue((overrides.branches ?? [{ id: 'b1', name: 'SM North' }]) as never);
    vi.mocked(prisma.inventoryMovement.count).mockResolvedValue((overrides.totalMovements ?? 0) as never);
  }

  it('returns fast movers ordered by consumption desc', async () => {
    mockPrismaCalls({
      consumption: [
        { ingredientId: 'ing-slow', _sum: { quantityChange: decimal(-5) } },
        { ingredientId: 'ing-fast', _sum: { quantityChange: decimal(-50) } },
      ],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.fast_movers.map((m) => m.ingredient_id)).toEqual(['ing-fast', 'ing-slow']);
    expect(result.fast_movers[0]).toMatchObject({ total_consumed: 50, avg_daily_consumption: 1.667 });
  });

  it('returns slow movers ordered by ascending consumption', async () => {
    mockPrismaCalls({
      consumption: [
        { ingredientId: 'ing-fast', _sum: { quantityChange: decimal(-50) } },
        { ingredientId: 'ing-slow', _sum: { quantityChange: decimal(-5) } },
      ],
      lastMovement: [{ ingredientId: 'ing-slow', _max: { createdAt: new Date('2026-07-10T00:00:00.000Z') } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.slow_movers.map((m) => m.ingredient_id)).toEqual(['ing-slow', 'ing-fast']);
    const slowest = result.slow_movers[0];
    expect(slowest).toBeDefined();
    expect(slowest?.days_since_last_movement).toBe(13);
  });

  it('computes waste trends grouped by day', async () => {
    mockPrismaCalls({
      waste: [
        { ingredientId: 'ing-fast', quantityChange: decimal(-2), createdAt: new Date('2026-07-10T08:00:00.000Z') },
        { ingredientId: 'ing-fast', quantityChange: decimal(-3), createdAt: new Date('2026-07-10T20:00:00.000Z') },
        { ingredientId: 'ing-slow', quantityChange: decimal(-1), createdAt: new Date('2026-07-11T08:00:00.000Z') },
      ],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.waste_trends).toEqual([
      { date: '2026-07-10', total_waste_quantity: 5, total_waste_cost: 25 },
      { date: '2026-07-11', total_waste_quantity: 1, total_waste_cost: 20 },
    ]);
  });

  it('computes turnover rate per branch', async () => {
    mockPrismaCalls({
      consumption: [{ ingredientId: 'ing-fast', _sum: { quantityChange: decimal(-10) } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    // consumed cost = 10 * 5 = 50; inventory value = 100*5 + 50*20 + 5*10 = 1550
    expect(result.turnover_by_branch).toEqual([
      { branch_id: 'b1', branch_name: 'SM North', turnover_rate: 0.032, total_consumed: 50, avg_inventory_value: 1550 },
    ]);
  });

  it('computes reorder recommendations with days until stockout', async () => {
    mockPrismaCalls({
      reorderConsumption: [{ ingredientId: 'ing-low', _sum: { quantityChange: decimal(-30) } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.reorder_recommendations).toHaveLength(1);
    expect(result.reorder_recommendations[0]).toMatchObject({ ingredient_id: 'ing-low', current_stock: 5, avg_daily_consumption: 1, days_until_stockout: 5 });
  });

  it('respects branchId filter', async () => {
    mockPrismaCalls({ ingredients: [ingredientRows[0]] });

    await reportsRepository.getInventoryAnalytics({ branchId: 'b1', dateFrom, dateTo, periodDays: 30 });

    expect(prisma.ingredient.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }));
    expect(prisma.inventoryMovement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ branchId: 'b1' }) }));
  });

  it('respects the period parameter when computing avg daily consumption', async () => {
    mockPrismaCalls({
      consumption: [{ ingredientId: 'ing-fast', _sum: { quantityChange: decimal(-90) } }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 90 });

    const fastest = result.fast_movers[0];
    expect(fastest).toBeDefined();
    expect(fastest?.avg_daily_consumption).toBe(1);
  });

  it('returns empty structures gracefully with no data', async () => {
    mockPrismaCalls({ ingredients: [] });

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
              'PRICE_OVERRIDE_APPROVED',
              'PRODUCT_REQUEST_APPROVED',
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
