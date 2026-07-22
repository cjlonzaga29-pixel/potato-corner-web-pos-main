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
          incurredAt: { gte: new Date('2026-07-01'), lte: new Date('2026-07-31') },
        }),
      }),
    );
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

describe('expensesRepository.findIdempotencyKey', () => {
  it('returns the record when it exists within the 24h window', async () => {
    const record = { id: 'key-1', key: 'abc', userId: 'user-1', expenseId: 'expense-1', createdAt: new Date() };
    vi.mocked(prisma.expenseIdempotencyKey.findFirst).mockResolvedValue(record as never);

    const result = await expensesRepository.findIdempotencyKey('abc', 'user-1');

    expect(result).toEqual(record);
    expect(prisma.expenseIdempotencyKey.findFirst).toHaveBeenCalledWith({
      where: { key: 'abc', userId: 'user-1', createdAt: { gte: expect.any(Date) } },
    });
  });

  it('returns null when no matching record exists', async () => {
    vi.mocked(prisma.expenseIdempotencyKey.findFirst).mockResolvedValue(null as never);

    const result = await expensesRepository.findIdempotencyKey('missing-key', 'user-1');

    expect(result).toBeNull();
  });
});
