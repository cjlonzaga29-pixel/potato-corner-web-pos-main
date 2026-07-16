import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    transaction: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    branch: { findMany: vi.fn(), findUnique: vi.fn() },
    shift: { findMany: vi.fn(), count: vi.fn() },
    inventoryMovement: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), count: vi.fn() },
    fraudAlert: { findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
    productVariant: { findMany: vi.fn() },
    flavor: { findMany: vi.fn() },
    ingredient: { findMany: vi.fn() },
    reportSnapshot: { create: vi.fn(), findFirst: vi.fn() },
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
