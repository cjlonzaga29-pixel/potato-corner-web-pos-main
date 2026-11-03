import { Prisma } from '@prisma/client';
import { EXPENSE_TYPED_CATEGORY } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { resolveDateRangeBoundary } from '../../lib/manila-time.js';
import { expenseTypesRepository } from '../expense-types/expense-types.repository.js';
import { ExpenseError, type CreateExpenseData, type ExpenseFilters, type ExpenseSummaryFilters, type IdempotencyClaim, type UpdateExpenseData } from './expenses.types.js';

const detailInclude = {
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, firstName: true, lastName: true } },
  expenseType: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.ExpenseInclude;

/**
 * The one definition of which expenses a filter means: the list, the summary and
 * the exports all come through here, so their totals can't disagree. A category
 * only ever matches legacy rows, since on a typed row it's a placeholder.
 */
function buildWhere(filters: ExpenseSummaryFilters): Prisma.ExpenseWhereInput {
  const scoped = filters.branch_id
    ? filters.branchIds === 'all' || filters.branchIds.includes(filters.branch_id)
      ? filters.branch_id
      : { in: [] }
    : filters.branchIds === 'all'
      ? undefined
      : { in: filters.branchIds };
  return {
    deletedAt: null,
    ...(scoped !== undefined && { branchId: scoped }),
    ...(filters.expense_type_id && { expenseTypeId: filters.expense_type_id }),
    ...((filters.category || filters.unassigned) && { expenseTypeId: null }),
    ...(filters.category && { category: filters.category as Prisma.EnumExpenseCategoryFilter['equals'] }),
    ...((filters.dateFrom || filters.dateTo) && {
      incurredAt: {
        // dateFrom/dateTo are bare Manila business dates (YYYY-MM-DD) — widen
        // to that day's Manila start/end rather than treating them as UTC
        // midnight, or a same-day filter silently disagrees with incurredAt
        // values written via manilaDateStringToUtc (see expenses.service.ts).
        ...(filters.dateFrom && { gte: resolveDateRangeBoundary(filters.dateFrom, 'start') }),
        ...(filters.dateTo && { lte: resolveDateRangeBoundary(filters.dateTo, 'end') }),
      },
    }),
  };
}

function typeProblem(reason: 'inactive' | 'unavailable'): ExpenseError {
  return reason === 'inactive'
    ? new ExpenseError('EXPENSE_TYPE_INACTIVE', 'This expense type was deactivated. Choose an active type.', 422)
    : new ExpenseError('EXPENSE_TYPE_UNAVAILABLE', 'This expense type is not available at this branch. Choose another type.', 422);
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
        // incurredAt is a business date, so a day's expenses tie: without the rest, one could repeat or vanish across pages.
        orderBy: [{ incurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        include: detailInclude,
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);
    return { expenses, total, totalAmount: aggregate._sum.amount?.toNumber() ?? 0 };
  },

  /** One grouped query over the same filters as findAll, whatever the number of types or records. */
  async summarize(filters: ExpenseSummaryFilters) {
    const rows = await prisma.expense.groupBy({
      by: ['expenseTypeId', 'category'],
      where: buildWhere(filters),
      _sum: { amount: true },
      _count: { _all: true },
    });
    const groups = new Map<string, { expenseTypeId: string | null; category: string | null; count: number; amount: Prisma.Decimal }>();
    for (const row of rows) {
      // An older API can edit a typed row's placeholder category, so a type folds its categories together.
      const key = row.expenseTypeId ? `type:${row.expenseTypeId}` : `legacy:${row.category}`;
      const group = groups.get(key) ?? { expenseTypeId: row.expenseTypeId, category: row.expenseTypeId ? null : row.category, count: 0, amount: new Prisma.Decimal(0) };
      group.count += row._count._all;
      group.amount = group.amount.add(row._sum.amount ?? 0);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, ...group, amount: group.amount.toNumber() }));
  },

  findById(id: string) {
    return prisma.expense.findFirst({ where: { id, deletedAt: null }, include: detailInclude });
  },

  /**
   * The expense, its type's checks and its idempotency key commit together or not at
   * all, and a retry waits on the first attempt's key instead of racing it. A failed
   * attempt leaves no key behind, so the same form can be corrected and resubmitted.
   */
  create(data: CreateExpenseData, createdBy: string, expenseTypeId: string | undefined, claim: IdempotencyClaim | null) {
    return prisma.$transaction(async (tx) => {
      if (claim) {
        const { count } = await tx.expenseIdempotencyKey.createMany({ data: [claim], skipDuplicates: true });
        if (count === 0) {
          return { replayOf: await tx.expenseIdempotencyKey.findUnique({ where: { key: claim.key } }), created: null };
        }
      }

      let expenseTypeName: string | undefined;
      if (expenseTypeId) {
        const usable = await expenseTypesRepository.lockUsable(expenseTypeId, data.branchId, tx);
        if (!usable.usable) throw typeProblem(usable.reason);
        expenseTypeName = usable.name;
      }

      const created = await tx.expense.create({
        data: {
          branchId: data.branchId,
          category: (expenseTypeId ? EXPENSE_TYPED_CATEGORY : data.category) as Prisma.ExpenseUncheckedCreateInput['category'],
          expenseTypeId,
          expenseTypeName,
          amount: data.amount,
          vendorName: data.vendorName,
          description: data.description,
          incurredAt: data.incurredAt,
          createdBy,
        },
        include: detailInclude,
      });
      if (claim) await tx.expenseIdempotencyKey.update({ where: { key: claim.key }, data: { expenseId: created.id } });
      return { replayOf: null, created };
    });
  },

  /** `recheckType` validates that type at the expense's branch inside this write, and a new type's name is recorded. */
  update(id: string, data: UpdateExpenseData, recheckType?: { expenseTypeId: string; branchId: string; recordName: boolean }) {
    return prisma.$transaction(async (tx) => {
      let typeFields: { expenseTypeId: string; expenseTypeName: string } | undefined;
      if (recheckType) {
        const usable = await expenseTypesRepository.lockUsable(recheckType.expenseTypeId, recheckType.branchId, tx);
        if (!usable.usable) throw typeProblem(usable.reason);
        if (recheckType.recordName) typeFields = { expenseTypeId: recheckType.expenseTypeId, expenseTypeName: usable.name };
      }
      return tx.expense.update({
        where: { id },
        data: {
          ...(data.branchId && { branchId: data.branchId }),
          ...(data.category && { category: data.category as Prisma.ExpenseUncheckedUpdateInput['category'] }),
          ...(data.amount !== undefined && { amount: data.amount }),
          ...(data.vendorName !== undefined && { vendorName: data.vendorName }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.incurredAt && { incurredAt: data.incurredAt }),
          ...typeFields,
        },
        include: detailInclude,
      });
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
};
