import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateExpenseData, ExpenseFilters, UpdateExpenseData } from './expenses.types.js';

const detailInclude = {
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ExpenseInclude;

function buildWhere(filters: ExpenseFilters): Prisma.ExpenseWhereInput {
  return {
    deletedAt: null,
    ...(filters.branchIds !== 'all' && { branchId: { in: filters.branchIds } }),
    ...(filters.branch_id && { branchId: filters.branch_id }),
    ...(filters.category && { category: filters.category as Prisma.EnumExpenseCategoryFilter['equals'] }),
    ...((filters.dateFrom || filters.dateTo) && {
      incurredAt: {
        ...(filters.dateFrom && { gte: new Date(filters.dateFrom) }),
        ...(filters.dateTo && { lte: new Date(filters.dateTo) }),
      },
    }),
  };
}

/**
 * Expenses repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const expensesRepository = {
  async findAll(filters: ExpenseFilters) {
    const where = buildWhere(filters);
    const [expenses, total, aggregate] = await Promise.all([
      prisma.expense.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { incurredAt: 'desc' },
        include: detailInclude,
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);
    return { expenses, total, totalAmount: aggregate._sum.amount?.toNumber() ?? 0 };
  },

  findById(id: string) {
    return prisma.expense.findFirst({ where: { id, deletedAt: null }, include: detailInclude });
  },

  create(data: CreateExpenseData, createdBy: string) {
    return prisma.expense.create({
      data: {
        branchId: data.branchId,
        category: data.category as Prisma.ExpenseUncheckedCreateInput['category'],
        amount: data.amount,
        vendorName: data.vendorName,
        description: data.description,
        incurredAt: data.incurredAt,
        createdBy,
      },
      include: detailInclude,
    });
  },

  update(id: string, data: UpdateExpenseData) {
    return prisma.expense.update({
      where: { id },
      data: {
        ...(data.branchId && { branchId: data.branchId }),
        ...(data.category && { category: data.category as Prisma.ExpenseUncheckedUpdateInput['category'] }),
        ...(data.amount !== undefined && { amount: data.amount }),
        ...(data.vendorName !== undefined && { vendorName: data.vendorName }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.incurredAt && { incurredAt: data.incurredAt }),
      },
      include: detailInclude,
    });
  },

  updateReceipt(id: string, receiptUrl: string | null, receiptKey: string | null) {
    return prisma.expense.update({
      where: { id },
      data: { receiptUrl, receiptKey },
      include: detailInclude,
    });
  },

  softDelete(id: string) {
    return prisma.expense.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  findIdempotencyKey(key: string, userId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return prisma.expenseIdempotencyKey.findFirst({
      where: { key, userId, createdAt: { gte: since } },
    });
  },

  recordIdempotencyKey(key: string, userId: string, expenseId: string) {
    return prisma.expenseIdempotencyKey.create({ data: { key, userId, expenseId } });
  },
};
