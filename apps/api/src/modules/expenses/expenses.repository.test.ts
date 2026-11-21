import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    expense: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    expenseIdempotencyKey: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { expensesRepository } = await import('./expenses.repository.js');

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expensesRepository.findAll', () => {
  it('returns rows, total, and totalAmount aggregated from the sum of amount', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([{ id: 'expense-1' }] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: decimal(1234.56) } } as never);

    const result = await expensesRepository.findAll({ branchIds: 'all', page: 1, limit: 25 });

    expect(result).toEqual({ expenses: [{ id: 'expense-1' }], total: 1, totalAmount: 1234.56 });
  });

  it('returns totalAmount 0 when there are no matching rows', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);

    const result = await expensesRepository.findAll({ branchIds: 'all', page: 1, limit: 25 });

    expect(result.totalAmount).toBe(0);
  });

  it('filters by branchIds when scoped to specific branches', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);

    await expensesRepository.findAll({ branchIds: ['branch-a', 'branch-b'], page: 1, limit: 25 });

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: { in: ['branch-a', 'branch-b'] } }) }),
    );
  });

  it('filters by category and date range', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);

    await expensesRepository.findAll({
      branchIds: 'all',
      category: 'utilities',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      page: 1,
      limit: 25,
    });

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          category: 'utilities',
          // On a typed row the category is a placeholder, so it only ever matches legacy rows.
          expenseTypeId: null,
          // Widened to Manila day boundaries, not UTC midnight — see
          // resolveDateRangeBoundary in apps/api/src/lib/manila-time.ts.
          incurredAt: { gte: new Date('2026-06-30T16:00:00.000Z'), lte: new Date('2026-07-31T15:59:59.999Z') },
        }),
      }),
    );
  });

  it('a requested branch narrows the caller\'s scope and can never widen it', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);

    await expensesRepository.findAll({ branchIds: ['branch-a'], branch_id: 'branch-z', page: 1, limit: 25 });

    expect(prisma.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ branchId: { in: [] } }) }));
  });

  it('orders ties deterministically, since a day\'s expenses share one business date', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);

    await expensesRepository.findAll({ branchIds: 'all', page: 1, limit: 25 });

    expect(prisma.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ incurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }));
  });

  it('always excludes soft-deleted expenses', async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.expense.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.expense.aggregate).mockResolvedValue({ _sum: { amount: null } } as never);

    await expensesRepository.findAll({ branchIds: 'all', page: 1, limit: 25 });

    expect(prisma.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }));
  });
});

describe('expensesRepository.softDelete', () => {
  it('sets deletedAt without removing the row', async () => {
    vi.mocked(prisma.expense.update).mockResolvedValue({ id: 'expense-1', deletedAt: new Date() } as never);

    await expensesRepository.softDelete('expense-1');

    expect(prisma.expense.update).toHaveBeenCalledWith({ where: { id: 'expense-1' }, data: { deletedAt: expect.any(Date) } });
  });
});

