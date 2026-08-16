import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    transaction: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    transactionItem: { groupBy: vi.fn(), findMany: vi.fn() },
    expense: { findMany: vi.fn() },
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
    unitConversion: { findUnique: vi.fn() },
    inventoryItemUnitConversion: { findUnique: vi.fn() },
    reportSnapshot: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
  };
  return { prisma: prismaMock };
});

vi.mock('../../lib/encryption.js', () => ({
  encryptField: vi.fn((value: string) => `encrypted(${value})`),
  hashField: vi.fn((value: string) => `hashed(${value})`),
  decryptField: vi.fn((value: string) => `decrypted(${value})`),
}));

const { prisma } = await import('../../lib/prisma.js');
const { decryptField } = await import('../../lib/encryption.js');
const { reportsRepository } = await import('./reports.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const baseFilters = { page: 1, limit: 25 } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportsRepository.getDailySales', () => {
  // Finance waterfall fields (cogs/gross_profit/waste_cost/expense_total/
  // operating_result) default to empty/zero here — dedicated tests below
  // exercise them explicitly. Every pre-existing test in this block only
  // asserts sales/discount/VAT fields, so leaving cost inputs at "no data"
  // keeps them at their old expected values (0).
  beforeEach(() => {
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([]);
    vi.mocked(prisma.expense.findMany).mockResolvedValue([]);
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([]);
  });

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
        cogs: 0,
        gross_profit: 112,
        waste_cost: 0,
        expense_total: 0,
        operating_result: 112,
        is_profit_estimated: false,
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

  it('wires COGS (from frozen deductionSnapshot), Waste Cost, and Expenses into gross_profit/operating_result without double-counting', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', subtotal: decimal(1000), totalAmount: decimal(1000), discountAmount: decimal(0), vatAmount: decimal(107.14), createdAt: new Date('2026-07-01T10:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([
      {
        deductionSnapshot: [{ inventoryItemId: 'item-1', quantity: 10, componentUnitCost: 30, componentCost: 300 }],
        transaction: { branchId: 'b1', createdAt: new Date('2026-07-01T10:00:00.000Z') },
      },
    ] as never);
    vi.mocked(prisma.expense.findMany).mockResolvedValue([{ branchId: 'b1', amount: decimal(150), incurredAt: new Date('2026-07-01T09:00:00.000Z') }] as never);
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      { branchId: 'b1', totalCost: decimal(50), createdAt: new Date('2026-07-01T08:00:00.000Z') },
    ] as never);

    const [row] = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    // gross_sales 1000, cogs 300 -> gross_profit 700; operating_result =
    // gross_profit(700) - waste_cost(50) - expense_total(150) = 500, and
    // expense_total must appear exactly once (not folded into cogs/waste).
    expect(row).toMatchObject({
      gross_sales: 1000,
      cogs: 300,
      gross_profit: 700,
      waste_cost: 50,
      expense_total: 150,
      operating_result: 500,
      is_profit_estimated: false,
    });
  });

  it('flags is_profit_estimated when a sale predates cost-snapshot capture', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { branchId: 'b1', status: 'completed', subtotal: decimal(500), totalAmount: decimal(500), discountAmount: decimal(0), vatAmount: decimal(53.57), createdAt: new Date('2026-07-01T10:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'b1', name: 'SM North' }] as never);
    // Legacy row: no deductionSnapshot at all.
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValue([
      { deductionSnapshot: null, transaction: { branchId: 'b1', createdAt: new Date('2026-07-01T10:00:00.000Z') } },
    ] as never);

    const [row] = await reportsRepository.getDailySales({ branchId: 'b1', page: 1, limit: 25 });

    expect(row?.is_profit_estimated).toBe(true);
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
        unitCost: decimal(2.5),
        totalCost: decimal(-5),
        proofKey: 'inventory-proofs/mv-1.webp',
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
        unit_cost: 2.5,
        total_cost: -5,
        proof_available: 'Yes',
        created_at: '2026-07-01T10:00:00.000Z',
      },
    ]);
    expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
  });

  it('reports proof_available as No when no proof photo was attached, and unit_cost/total_cost as null when the item has never been costed', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        id: 'mv-legacy', branchId: 'b1', inventoryItemId: 'item-1', movementType: 'SALE',
        quantityChange: decimal(-2), quantityBefore: decimal(10), quantityAfter: decimal(8),
        referenceType: null, referenceId: null, notes: null,
        performedByUserId: null, unitCost: null, totalCost: null, proofKey: null,
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato' }, unit: { code: 'kg' },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryMovement({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]?.proof_available).toBe('No');
    expect(rows[0]?.unit_cost).toBeNull();
    expect(rows[0]?.total_cost).toBeNull();
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

  // INVENTORY AUDIT FOLLOW-UPS §2A/§6/Phase 6 — a TRANSFER_IN row with no
  // proof_key of its own still reports Yes when its sibling TRANSFER_OUT leg
  // (same reference_id) has one — never inferred from movement_type alone.
  it('reports proof_available Yes for a TRANSFER_IN row whose sibling TRANSFER_OUT leg has the proof', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValueOnce([
      {
        id: 'mv-in', branchId: 'b2', inventoryItemId: 'item-1', movementType: 'TRANSFER_IN',
        quantityChange: decimal(5), quantityBefore: decimal(10), quantityAfter: decimal(15),
        referenceType: 'transfer', referenceId: 'evt-1', notes: null,
        performedByUserId: null, unitCost: null, totalCost: null, proofKey: null,
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM South' }, inventoryItem: { name: 'Potato' }, unit: { code: 'kg' },
      },
    ] as never);
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValueOnce([{ referenceId: 'evt-1' }] as never);

    const rows = await reportsRepository.getInventoryMovement(baseFilters);

    expect(prisma.inventoryStockMovement.findMany).toHaveBeenCalledTimes(2);
    expect(rows[0]?.proof_available).toBe('Yes');
  });

  it('reports proof_available No for a TRANSFER row when neither it nor its sibling has a proof', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValueOnce([
      {
        id: 'mv-in', branchId: 'b2', inventoryItemId: 'item-1', movementType: 'TRANSFER_IN',
        quantityChange: decimal(5), quantityBefore: decimal(10), quantityAfter: decimal(15),
        referenceType: 'transfer', referenceId: 'evt-1', notes: null,
        performedByUserId: null, unitCost: null, totalCost: null, proofKey: null,
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM South' }, inventoryItem: { name: 'Potato' }, unit: { code: 'kg' },
      },
    ] as never);
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValueOnce([] as never);

    const rows = await reportsRepository.getInventoryMovement(baseFilters);

    expect(rows[0]?.proof_available).toBe('No');
  });

  it('never looks up a sibling proof for a non-transfer row (never infers proof from movement_type)', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValueOnce([
      {
        id: 'mv-adj', branchId: 'b1', inventoryItemId: 'item-1', movementType: 'ADJUSTMENT_OUT',
        quantityChange: decimal(-2), quantityBefore: decimal(10), quantityAfter: decimal(8),
        referenceType: null, referenceId: null, notes: null,
        performedByUserId: null, unitCost: null, totalCost: null, proofKey: null,
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato' }, unit: { code: 'kg' },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryMovement(baseFilters);

    expect(prisma.inventoryStockMovement.findMany).toHaveBeenCalledTimes(1);
    expect(rows[0]?.proof_available).toBe('No');
  });
});

// SALE MOVEMENT COST SNAPSHOT FIX — cost must come from each SALE
// movement's own unit_cost/total_cost snapshot (captured at deduction time),
// never from InventoryItem's *current* cost — otherwise a later receiving
// silently reprices an already-reported historical consumption total.
describe('reportsRepository.getInventoryConsumptionSummary', () => {
  it('uses the movement-level unit_cost/total_cost snapshot, not InventoryItem.unitCost', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-1',
        quantityChange: decimal(-5),
        // Movement captured ₱10/unit at deduction time — must win even though
        // the item's *current* cost (never read by this path) is different.
        unitCost: decimal(10),
        totalCost: decimal(-50),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Potato', unitCost: decimal(999), baseUnit: { code: 'g' } },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryConsumptionSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows).toEqual([
      {
        ingredient_id: 'item-1',
        ingredient_name: 'Potato',
        branch_id: 'b1',
        branch_name: 'SM North',
        unit: 'g',
        quantity_consumed: 5,
        unit_cost: 10,
        consumption_value: 50,
        has_unknown_cost: false,
        movement_count: 1,
      },
    ]);
  });

  // Reconciliation scenario (SALE MOVEMENT COST SNAPSHOT FIX §8): 100 units
  // @ ₱10 sells 5 units (SALE movement snapshot ₱10/unit, ₱50 total), then a
  // later receiving moves the weighted average to ₱20. The already-recorded
  // SALE movement's cost must not be reread at the new average — this
  // report must still show ₱50 for that historical consumption.
  it('is unaffected by a since-changed current cost — the historical SALE snapshot stands', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-1',
        quantityChange: decimal(-5),
        unitCost: decimal(10),
        totalCost: decimal(-50),
        branch: { name: 'SM North' },
        // Current InventoryItem.unitCost has since moved to ₱20 (post-receiving) —
        // must have zero effect on this row.
        inventoryItem: { name: 'Potato', unitCost: decimal(20), baseUnit: { code: 'g' } },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryConsumptionSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]?.unit_cost).toBe(10);
    expect(rows[0]?.consumption_value).toBe(50);
  });

  it('sums quantity and cost across multiple SALE movements for the same ingredient/branch', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        branchId: 'b1', inventoryItemId: 'item-1', quantityChange: decimal(-5), unitCost: decimal(10), totalCost: decimal(-50),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato', unitCost: null, baseUnit: { code: 'g' } },
      },
      {
        branchId: 'b1', inventoryItemId: 'item-1', quantityChange: decimal(-3), unitCost: decimal(10), totalCost: decimal(-30),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato', unitCost: null, baseUnit: { code: 'g' } },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryConsumptionSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]?.quantity_consumed).toBe(8);
    expect(rows[0]?.consumption_value).toBe(80);
    expect(rows[0]?.unit_cost).toBe(10);
    expect(rows[0]?.movement_count).toBe(2);
  });

  it('never fabricates a legacy null-cost movement as ₱0 — reports unit_cost/consumption_value as null and flags has_unknown_cost', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        branchId: 'b1', inventoryItemId: 'item-1', quantityChange: decimal(-5), unitCost: null, totalCost: null,
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato', unitCost: null, baseUnit: { code: 'g' } },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryConsumptionSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]?.quantity_consumed).toBe(5); // consumption quantity still shown
    expect(rows[0]?.unit_cost).toBeNull();
    expect(rows[0]?.consumption_value).toBeNull();
    expect(rows[0]?.has_unknown_cost).toBe(true);
  });

  it('flags has_unknown_cost and reports only the known-cost portion when a bucket mixes costed and legacy-null movements', async () => {
    vi.mocked(prisma.inventoryStockMovement.findMany).mockResolvedValue([
      {
        branchId: 'b1', inventoryItemId: 'item-1', quantityChange: decimal(-5), unitCost: decimal(10), totalCost: decimal(-50),
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato', unitCost: null, baseUnit: { code: 'g' } },
      },
      {
        branchId: 'b1', inventoryItemId: 'item-1', quantityChange: decimal(-3), unitCost: null, totalCost: null,
        branch: { name: 'SM North' }, inventoryItem: { name: 'Potato', unitCost: null, baseUnit: { code: 'g' } },
      },
    ] as never);

    const rows = await reportsRepository.getInventoryConsumptionSummary({ branchId: 'b1', page: 1, limit: 25 });

    expect(rows[0]?.quantity_consumed).toBe(8); // all quantity still counted
    expect(rows[0]?.consumption_value).toBe(50); // only the known-cost movement's total
    // Never a blended known-cost-over-mixed-quantity rate (50/8 = 6.25 would
    // understate the real ₱10/unit rate and imply false precision).
    expect(rows[0]?.unit_cost).toBeNull();
    expect(rows[0]?.has_unknown_cost).toBe(true);
  });
});

// TASK 157 — split into two independently-dimensioned tables (ingredient
// weight in kg, packaging in native count), replacing TASK 144's
// getInventorySummary (flat native-unit rows) and TASK 149's
// getInventorySummaryWeightKg (totals-only kg roll-up).
describe('reportsRepository.getInventorySummarySplit', () => {
  beforeEach(() => {
    vi.mocked(prisma.unitOfMeasure.findUnique).mockImplementation((async (args: { where: { code: string } }) => {
      if (args.where.code === 'kg') return { id: 'unit-kg', code: 'kg' };
      if (args.where.code === 'g') return { id: 'unit-g', code: 'g' };
      return null;
    }) as never);
    vi.mocked(prisma.inventoryItemUnitConversion.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.unitConversion.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.inventoryStockMovement.groupBy).mockResolvedValue([] as never);
  });

  it('returns empty tables without querying movements when the branch has no stock rows', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([]);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg).toEqual([]);
    expect(result.packagingPc).toEqual([]);
    expect(prisma.inventoryStockMovement.groupBy).not.toHaveBeenCalled();
  });

  it('a g-tracked ingredient (Salt) appears in the KG table — 1000 g converts to exactly 1 kg (identity, no conversion lookup)', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-salt',
        quantityOnHand: decimal(1000),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Salt', baseUnit: { id: 'unit-g', code: 'g', dimension: 'WEIGHT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg).toEqual([
      {
        ingredient_id: 'item-salt',
        ingredient_name: 'Salt',
        branch_id: 'b1',
        branch_name: 'SM North',
        unit_code: 'g',
        opening_stock: 1000,
        consumed_today: 0,
        consumed_this_month: 0,
        remaining: 1000,
        opening_stock_kg: 1,
        consumed_today_kg: 0,
        consumed_this_month_kg: 0,
        remaining_kg: 1,
        status: 'converted',
      },
    ]);
    expect(result.excludedIngredientCount).toBe(0);
  });

  it('2304 g (Raw Fries) becomes exactly 2.304 kg', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-raw-fries',
        quantityOnHand: decimal(2304),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Raw Fries', baseUnit: { id: 'unit-g', code: 'g', dimension: 'WEIGHT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg[0]?.remaining_kg).toBe(2.304);
  });

  it('a kg-tracked ingredient (Flour) appears unchanged — factor 1, no conversion lookup at all', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-flour',
        quantityOnHand: decimal(10.2),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Flour', baseUnit: { id: 'unit-kg', code: 'kg', dimension: 'WEIGHT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg[0]?.remaining_kg).toBe(10.2);
    expect(prisma.inventoryItemUnitConversion.findUnique).not.toHaveBeenCalled();
    expect(prisma.unitConversion.findUnique).not.toHaveBeenCalled();
  });

  it('a tbsp item appears in the KG table only when its item-specific conversion exists (Cheese Flavor Powder, 1 tbsp = 7 g)', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-cheese',
        quantityOnHand: decimal(23.5),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Cheese Flavor Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'WEIGHT' } },
      },
    ] as never);
    vi.mocked(prisma.inventoryItemUnitConversion.findUnique).mockImplementation((async (args: {
      where: { inventoryItemId_fromUnitId_toUnitId: { inventoryItemId: string; fromUnitId: string; toUnitId: string } };
    }) => {
      const key = args.where.inventoryItemId_fromUnitId_toUnitId;
      if (key.inventoryItemId === 'item-cheese' && key.fromUnitId === 'unit-tbsp' && key.toUnitId === 'unit-g') {
        return { factor: decimal(7) };
      }
      return null;
    }) as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    // 23.5 tbsp x 7g / 1000 = 0.1645 kg
    expect(result.ingredientWeightKg[0]?.remaining_kg).toBeCloseTo(0.1645, 3);
    expect(result.excludedIngredientCount).toBe(0);
  });

  it('two tbsp ingredients use their own distinct item-specific factors (Cheese Powder 1 tbsp = 7 g, Flavored Fries Powder 1 tbsp = 6 g)', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-cheese',
        quantityOnHand: decimal(100),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Cheese Flavor Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'WEIGHT' } },
      },
      {
        branchId: 'b1',
        inventoryItemId: 'item-fries-powder',
        quantityOnHand: decimal(10),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Flavored Fries Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'WEIGHT' } },
      },
    ] as never);
    vi.mocked(prisma.inventoryItemUnitConversion.findUnique).mockImplementation((async (args: {
      where: { inventoryItemId_fromUnitId_toUnitId: { inventoryItemId: string; fromUnitId: string; toUnitId: string } };
    }) => {
      const key = args.where.inventoryItemId_fromUnitId_toUnitId;
      if (key.toUnitId !== 'unit-g') return null;
      if (key.inventoryItemId === 'item-cheese') return { factor: decimal(7) };
      if (key.inventoryItemId === 'item-fries-powder') return { factor: decimal(6) };
      return null;
    }) as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    const cheese = result.ingredientWeightKg.find((r) => r.ingredient_id === 'item-cheese');
    const fries = result.ingredientWeightKg.find((r) => r.ingredient_id === 'item-fries-powder');
    expect(cheese?.remaining_kg).toBe(0.7); // 100 tbsp x 7g = 700g = 0.7kg
    expect(fries?.remaining_kg).toBe(0.06); // 10 tbsp x 6g = 60g = 0.06kg
  });

  // TASK 209.56D — owner-confirmed Potato Corner powder density: 1 tbsp = 0.006 kg,
  // configured as a direct item-specific tbsp->kg InventoryItemUnitConversion
  // (not tbsp->g like the tests above), so resolveKgFactor resolves it on the
  // first (kg-targeted) lookup without ever consulting the g-targeted or global paths.
  describe('TASK 209.56D — Potato Corner powder tbsp->kg conversion (1 tbsp = 0.006 kg)', () => {
    function mockBbqTbspToKgConversion() {
      vi.mocked(prisma.inventoryItemUnitConversion.findUnique).mockImplementation((async (args: {
        where: { inventoryItemId_fromUnitId_toUnitId: { inventoryItemId: string; fromUnitId: string; toUnitId: string } };
      }) => {
        const key = args.where.inventoryItemId_fromUnitId_toUnitId;
        if (key.inventoryItemId === 'item-bbq' && key.fromUnitId === 'unit-tbsp' && key.toUnitId === 'unit-kg') {
          return { factor: decimal(0.006) };
        }
        return null;
      }) as never);
    }

    it.each([
      [1, 0.006],
      [2.5, 0.015],
      [10, 0.06],
      [100, 0.6],
    ])('%s tbsp converts to exactly %s kg', async (tbsp, expectedKg) => {
      vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
        {
          branchId: 'b1',
          inventoryItemId: 'item-bbq',
          quantityOnHand: decimal(tbsp),
          branch: { name: 'SM North' },
          inventoryItem: { name: 'BBQ Flavor Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'VOLUME' } },
        },
      ] as never);
      mockBbqTbspToKgConversion();

      const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

      expect(result.ingredientWeightKg[0]?.remaining_kg).toBe(expectedKg);
    });

    it('matches the Inventory Summary screenshot example exactly: BBQ Flavor Powder opening 1091.34 tbsp / consumed today 1.5 / consumed month 10.16 / remaining 1089.84, all x0.006, status converted', async () => {
      vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
        {
          branchId: 'b1',
          inventoryItemId: 'item-bbq',
          quantityOnHand: decimal(1089.84),
          branch: { name: 'SM North' },
          inventoryItem: { name: 'BBQ Flavor Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'VOLUME' } },
        },
      ] as never);
      // remaining (1089.84) - todayNet (-1.5) = opening 1091.34.
      vi.mocked(prisma.inventoryStockMovement.groupBy)
        .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-bbq', _sum: { quantityChange: decimal(-1.5) } }] as never)
        .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-bbq', _sum: { quantityChange: decimal(-1.5) } }] as never)
        .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-bbq', _sum: { quantityChange: decimal(-10.16) } }] as never);
      mockBbqTbspToKgConversion();

      const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

      expect(result.ingredientWeightKg[0]).toMatchObject({
        opening_stock: 1091.34,
        consumed_today: 1.5,
        consumed_this_month: 10.16,
        remaining: 1089.84,
        opening_stock_kg: 6.54804,
        consumed_today_kg: 0.009,
        consumed_this_month_kg: 0.06096,
        remaining_kg: 6.53904,
        status: 'converted',
      });
    });

    it('a configured powder never queries the global UnitConversion table (item-specific factor short-circuits it)', async () => {
      vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
        {
          branchId: 'b1',
          inventoryItemId: 'item-bbq',
          quantityOnHand: decimal(10),
          branch: { name: 'SM North' },
          inventoryItem: { name: 'BBQ Flavor Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'VOLUME' } },
        },
      ] as never);
      mockBbqTbspToKgConversion();

      await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

      expect(prisma.unitConversion.findUnique).not.toHaveBeenCalled();
    });

    it('an unrelated tbsp ingredient without its own configured conversion stays Conversion Needed even while a configured powder converts — no accidental global tbsp->kg fallback', async () => {
      vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
        {
          branchId: 'b1',
          inventoryItemId: 'item-bbq',
          quantityOnHand: decimal(10),
          branch: { name: 'SM North' },
          inventoryItem: { name: 'BBQ Flavor Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'VOLUME' } },
        },
        {
          branchId: 'b1',
          inventoryItemId: 'item-unrelated',
          quantityOnHand: decimal(10),
          branch: { name: 'SM North' },
          inventoryItem: { name: 'Some Other Tbsp Ingredient', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'VOLUME' } },
        },
      ] as never);
      mockBbqTbspToKgConversion();

      const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

      const bbq = result.ingredientWeightKg.find((r) => r.ingredient_id === 'item-bbq');
      const unrelated = result.ingredientWeightKg.find((r) => r.ingredient_id === 'item-unrelated');
      expect(bbq?.status).toBe('converted');
      expect(bbq?.remaining_kg).toBe(0.06);
      expect(unrelated?.status).toBe('conversion_needed');
      expect(unrelated?.remaining_kg).toBeNull();
    });
  });

  it('still shows an item with no resolvable conversion (never invents a factor) — native columns populated, kg columns null, status conversion_needed — and increments excludedIngredientCount (excluded from KG totals only)', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-mystery',
        quantityOnHand: decimal(50),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Mystery Powder', baseUnit: { id: 'unit-tbsp', code: 'tbsp', dimension: 'WEIGHT' } },
      },
    ] as never);
    // beforeEach already makes every item-specific and global conversion lookup resolve to null.

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg).toEqual([
      {
        ingredient_id: 'item-mystery',
        ingredient_name: 'Mystery Powder',
        branch_id: 'b1',
        branch_name: 'SM North',
        unit_code: 'tbsp',
        opening_stock: 50,
        consumed_today: 0,
        consumed_this_month: 0,
        remaining: 50,
        opening_stock_kg: null,
        consumed_today_kg: null,
        consumed_this_month_kg: null,
        remaining_kg: null,
        status: 'conversion_needed',
      },
    ]);
    expect(result.excludedIngredientCount).toBe(1);
    expect(result.ingredientWeightTotalsKg).toEqual({ opening_stock_kg: 0, consumed_today_kg: 0, consumed_this_month_kg: 0, remaining_kg: 0 });
    expect(prisma.inventoryItemUnitConversion.findUnique).toHaveBeenCalled();
    expect(prisma.unitConversion.findUnique).toHaveBeenCalled();
  });

  it('a pcs-tracked (COUNT-dimension) packaging item appears only in the Packaging table, never the KG table', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-cups',
        quantityOnHand: decimal(240),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Regular Cup', baseUnit: { id: 'unit-pcs', code: 'pcs', dimension: 'COUNT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg).toEqual([]);
    expect(result.packagingPc).toEqual([
      {
        ingredient_id: 'item-cups',
        ingredient_name: 'Regular Cup',
        branch_id: 'b1',
        branch_name: 'SM North',
        opening_stock_pc: 240,
        consumed_today_pc: 0,
        consumed_this_month_pc: 0,
        remaining_pc: 240,
      },
    ]);
    expect(result.excludedIngredientCount).toBe(0);
  });

  it('COUNT-dimension rows never query a weight conversion and never trigger the missing-conversion count', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-cups',
        quantityOnHand: decimal(240),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Regular Cup', baseUnit: { id: 'unit-pcs', code: 'pcs', dimension: 'COUNT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.excludedIngredientCount).toBe(0);
    expect(prisma.inventoryItemUnitConversion.findUnique).not.toHaveBeenCalled();
    expect(prisma.unitConversion.findUnique).not.toHaveBeenCalled();
  });

  it('ingredientWeightTotalsKg equals the sum of the visible KG rows', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-raw-fries',
        quantityOnHand: decimal(1536),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Raw Fries', baseUnit: { id: 'unit-g', code: 'g', dimension: 'WEIGHT' } },
      },
      {
        branchId: 'b1',
        inventoryItemId: 'item-flour',
        quantityOnHand: decimal(10),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Flour', baseUnit: { id: 'unit-kg', code: 'kg', dimension: 'WEIGHT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    const expectedSum = result.ingredientWeightKg.reduce((sum, r) => sum + (r.remaining_kg ?? 0), 0);
    expect(result.ingredientWeightTotalsKg.remaining_kg).toBeCloseTo(expectedSum, 6);
    expect(result.ingredientWeightTotalsKg.remaining_kg).toBeCloseTo(1.536 + 10, 3);
  });

  it('packagingTotalsPc equals the sum of the visible PC rows', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-cups',
        quantityOnHand: decimal(240),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Regular Cup', baseUnit: { id: 'unit-pcs', code: 'pcs', dimension: 'COUNT' } },
      },
      {
        branchId: 'b1',
        inventoryItemId: 'item-lids',
        quantityOnHand: decimal(60),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Lids', baseUnit: { id: 'unit-pcs', code: 'pcs', dimension: 'COUNT' } },
      },
    ] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    const expectedSum = result.packagingPc.reduce((sum, r) => sum + r.remaining_pc, 0);
    expect(result.packagingTotalsPc.remaining_pc).toBe(expectedSum);
    expect(result.packagingTotalsPc.remaining_pc).toBe(300);
  });

  it('calculates opening, consumed_today, and consumed_this_month KG independently, matching the stock/movement snapshot', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([
      {
        branchId: 'b1',
        inventoryItemId: 'item-salt',
        quantityOnHand: decimal(1000),
        branch: { name: 'SM North' },
        inventoryItem: { name: 'Salt', baseUnit: { id: 'unit-g', code: 'g', dimension: 'WEIGHT' } },
      },
    ] as never);
    // Today: net -200 (opening = 1000 - (-200) = 1200); SALE today = -100; SALE this month = -400.
    vi.mocked(prisma.inventoryStockMovement.groupBy)
      .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-salt', _sum: { quantityChange: decimal(-200) } }] as never)
      .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-salt', _sum: { quantityChange: decimal(-100) } }] as never)
      .mockResolvedValueOnce([{ branchId: 'b1', inventoryItemId: 'item-salt', _sum: { quantityChange: decimal(-400) } }] as never);

    const result = await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

    expect(result.ingredientWeightKg[0]).toMatchObject({
      opening_stock_kg: 1.2,
      consumed_today_kg: 0.1,
      consumed_this_month_kg: 0.4,
      remaining_kg: 1,
    });
  });

  it('scopes InventoryStock.findMany to the given branchId', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValue([]);

    await reportsRepository.getInventorySummarySplit({ branchId: 'b1', page: 1, limit: 25 });

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

  it('computes waste trends grouped by Manila calendar day, not UTC day, using each movement\'s own frozen cost snapshot', async () => {
    mockPrismaCalls({
      waste: [
        // 2026-07-10T08:00:00Z == 2026-07-10T16:00+08:00 -> Manila July 10
        { inventoryItemId: 'item-fast', branchId: 'b1', quantityChange: decimal(-2), createdAt: new Date('2026-07-10T08:00:00.000Z'), totalCost: decimal(10) },
        // 2026-07-10T20:00:00Z == 2026-07-11T04:00+08:00 -> already Manila July 11,
        // even though the UTC calendar date is still the 10th.
        { inventoryItemId: 'item-fast', branchId: 'b1', quantityChange: decimal(-3), createdAt: new Date('2026-07-10T20:00:00.000Z'), totalCost: decimal(15) },
        { inventoryItemId: 'item-slow', branchId: 'b1', quantityChange: decimal(-1), createdAt: new Date('2026-07-11T08:00:00.000Z'), totalCost: decimal(20) },
      ],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.waste_trends).toEqual([
      // Only the 08:00Z entry (qty 2, snapshotted cost 10) is Manila July 10.
      { date: '2026-07-10', total_waste_quantity: 2, total_waste_cost: 10 },
      // The 20:00Z item-fast entry (qty 3, snapshotted cost 15) rolls into
      // Manila July 11 alongside item-slow's entry (qty 1, snapshotted cost 20).
      { date: '2026-07-11', total_waste_quantity: 4, total_waste_cost: 35 },
    ]);
  });

  it('does not recompute waste cost from today\'s average when the snapshot and current cost diverge (historical stability)', async () => {
    mockPrismaCalls({
      // Today's stock unitCost for item-fast is 5 (via stockRows fallback),
      // but this movement's own frozen snapshot says 2 — a purchase-price
      // change after the fact must not retroactively inflate/deflate it.
      waste: [{ inventoryItemId: 'item-fast', branchId: 'b1', quantityChange: decimal(-2), createdAt: new Date('2026-07-10T08:00:00.000Z'), totalCost: decimal(2) }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.waste_trends).toEqual([{ date: '2026-07-10', total_waste_quantity: 2, total_waste_cost: 2 }]);
  });

  it('treats a legacy waste row with no cost snapshot as contributing 0 cost, not a fabricated figure', async () => {
    mockPrismaCalls({
      waste: [{ inventoryItemId: 'item-fast', branchId: 'b1', quantityChange: decimal(-2), createdAt: new Date('2026-07-10T08:00:00.000Z'), totalCost: null }],
    });

    const result = await reportsRepository.getInventoryAnalytics({ dateFrom, dateTo, periodDays: 30 });

    expect(result.waste_trends).toEqual([{ date: '2026-07-10', total_waste_quantity: 2, total_waste_cost: 0 }]);
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

// Task 209.5 — discount-proof availability on the per-transaction row used
// by both the Daily Sales PDF and the Discount Compliance CSV/PDF exports.
describe('reportsRepository.getDailySalesTransactions', () => {
  function transactionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'txn-1',
      transactionNumber: 'PC-B1-20260806-0001',
      paymentMethod: 'cash',
      totalAmount: decimal(100),
      vatAmount: decimal(0),
      discountAmount: decimal(20),
      discountType: 'senior_citizen',
      createdAt: new Date('2026-08-06T10:00:00.000Z'),
      cashier: { firstName: 'Jane', lastName: 'Doe' },
      branch: { name: 'Branch One' },
      discountProofKey: null,
      ...overrides,
    };
  }

  it("maps discount_proof_available to 'Yes' when a discount proof key is present", async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([transactionRow({ discountProofKey: 'branch-1/shift-1/user-1-123.webp' })] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]?.discount_proof_available).toBe('Yes');
  });

  it("maps discount_proof_available to 'No' when no discount proof key is present", async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([transactionRow({ discountProofKey: null })] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]?.discount_proof_available).toBe('No');
  });

  it('never selects the raw storage key onto the returned row shape — only the derived Yes/No flag', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([transactionRow({ discountProofKey: 'branch-1/shift-1/user-1-123.webp' })] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]).not.toHaveProperty('discount_proof_key');
    expect(rows[0]).not.toHaveProperty('discountProofKey');
  });

  it('includes transaction_id and branch_name for the Discount Compliance column set', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([transactionRow()] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]).toMatchObject({ transaction_id: 'txn-1', branch_name: 'Branch One' });
  });

  // Task: Discount Compliance CSV/PDF parity — discount_id_reference is the
  // decrypted discountCustomerIdEncrypted, same field/decrypt utility
  // transactions.service.ts's getDiscountAuditTrail already uses for the screen.
  it('decrypts discountCustomerIdEncrypted into discount_id_reference when present', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      transactionRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' }),
    ] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]).toMatchObject({ discount_id_reference: 'decrypted(encrypted(PWD-12345))' });
  });

  it('leaves discount_id_reference null when discountCustomerIdEncrypted is null', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      transactionRow({ discountCustomerIdEncrypted: null }),
    ] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]).toMatchObject({ discount_id_reference: null });
  });

  it('does not crash the export when a legacy discountCustomerIdEncrypted fails to decrypt — falls through to null', async () => {
    vi.mocked(decryptField).mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      transactionRow({ discountCustomerIdEncrypted: 'garbled-ciphertext' }),
    ] as never);

    const rows = await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(rows[0]).toMatchObject({ discount_id_reference: null });
  });

  // Task 209.10 — Sold Product Transactions export-parity fix: the tab's
  // client-side cashier/payment-method/status/search filters must reach the
  // same where-clause the on-screen query uses, or the export silently
  // returns a different result set than what's visible.
  it('defaults status to completed when the caller passes no status filter', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([transactionRow()] as never);

    await reportsRepository.getDailySalesTransactions(baseFilters);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'completed' }) }));
  });

  it('passes cashierId, paymentMethod, status, and search through to the where clause when provided', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([transactionRow()] as never);

    await reportsRepository.getDailySalesTransactions({
      ...baseFilters,
      cashierId: 'cashier-1',
      paymentMethod: 'gcash',
      status: 'voided',
      search: 'PC-0002',
    });

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cashierId: 'cashier-1',
          paymentMethod: 'gcash',
          status: 'voided',
          transactionNumber: { contains: 'PC-0002', mode: 'insensitive' },
        }),
      }),
    );
  });
});
