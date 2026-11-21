import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateExpenseTypeData, UpdateExpenseTypeData } from './expense-types.types.js';

const typeInclude = {
  branches: { select: { branchId: true, branch: { select: { name: true } } } },
} satisfies Prisma.ExpenseTypeInclude;

type Client = Prisma.TransactionClient | typeof prisma;

/** POS-PERF-P60 — all Prisma calls for this module live here. */
export const expenseTypesRepository = {
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(work);
  },

  findMany(where: { branchIds?: string[]; includeInactive: boolean }) {
    return prisma.expenseType.findMany({
      where: {
        ...(where.includeInactive ? {} : { isActive: true }),
        ...(where.branchIds && { branches: { some: { branchId: { in: where.branchIds } } } }),
      },
      include: typeInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },

  findById(expenseTypeId: string, client: Client = prisma) {
    return client.expenseType.findUnique({ where: { id: expenseTypeId }, include: typeInclude });
  },

  /** Current name and status by id, whatever the scope: a breakdown must still name every expense it counts. */
  findNames(expenseTypeIds: string[]) {
    return prisma.expenseType.findMany({ where: { id: { in: expenseTypeIds } }, select: { id: true, name: true, isActive: true } });
  },

  /** branchIds limits the count to what the caller may see. */
  async countExpensesByType(expenseTypeIds: string[], branchIds: 'all' | string[], client: Client = prisma) {
    if (expenseTypeIds.length === 0) return new Map<string, number>();
    const rows = await client.expense.groupBy({
      by: ['expenseTypeId'],
      where: { expenseTypeId: { in: expenseTypeIds }, deletedAt: null, ...(branchIds !== 'all' && { branchId: { in: branchIds } }) },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.expenseTypeId as string, row._count._all]));
  },

  findActiveBranchIds(branchIds: string[], client: Client = prisma) {
    return client.branch.findMany({ where: { id: { in: branchIds }, status: 'active' }, select: { id: true } });
  },

  async create(data: CreateExpenseTypeData, branchIds: string[], tx: Prisma.TransactionClient) {
    const type = await tx.expenseType.create({ data });
    await tx.expenseTypeBranch.createMany({
      data: branchIds.map((branchId) => ({ expenseTypeId: type.id, branchId, normalizedName: data.normalizedName, isActive: true })),
    });
    return tx.expenseType.findUniqueOrThrow({ where: { id: type.id }, include: typeInclude });
  },

  /**
   * Compare-and-swap on version, as productTypes.update. False when the version
   * moved. Holds the row until the caller's transaction ends, which is what orders
   * a scope edit against an expense being recorded: see lockUsable.
   */
  async compareAndUpdate(expenseTypeId: string, data: UpdateExpenseTypeData, expectedVersion: number, tx: Prisma.TransactionClient) {
    const { count } = await tx.expenseType.updateMany({
      where: { id: expenseTypeId, version: expectedVersion },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1;
  },

  /** Including soft-deleted rows: nothing here decides those are gone for good. */
  countExpensesAtBranches(expenseTypeId: string, branchIds: string[], tx: Prisma.TransactionClient) {
    return tx.expense.groupBy({ by: ['branchId'], where: { expenseTypeId, branchId: { in: branchIds } }, _count: { _all: true } });
  },

  async replaceScope(expenseTypeId: string, added: string[], removed: string[], tx: Prisma.TransactionClient) {
    if (removed.length > 0) await tx.expenseTypeBranch.deleteMany({ where: { expenseTypeId, branchId: { in: removed } } });
    if (added.length === 0) return;
    const { normalizedName, isActive } = await tx.expenseType.findUniqueOrThrow({ where: { id: expenseTypeId }, select: { normalizedName: true, isActive: true } });
    await tx.expenseTypeBranch.createMany({ data: added.map((branchId) => ({ expenseTypeId, branchId, normalizedName, isActive })) });
  },

  /** Only ever touches this row: expenses keep their type, recorded name, amount and proof. */
  async setActive(expenseTypeId: string, isActive: boolean, expectedVersion: number, actorId: string) {
    const { count } = await prisma.expenseType.updateMany({
      where: { id: expenseTypeId, version: expectedVersion },
      data: { isActive, deactivatedAt: isActive ? null : new Date(), updatedById: actorId, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (count === 0) return null;
    return prisma.expenseType.findUniqueOrThrow({ where: { id: expenseTypeId }, include: typeInclude });
  },

  /**
   * Whether an expense at this branch may use the type right now, holding the type's
   * row lock until the caller's transaction ends. The update writes the value it
   * matched, so nothing changes (version and updatedAt included) and nothing cascades.
   * Scope and name are read after the lock, so a deactivation, rename or scope edit
   * either commits first and is seen here, or waits until this expense has committed.
   */
  async lockUsable(expenseTypeId: string, branchId: string, tx: Prisma.TransactionClient) {
    const { count } = await tx.expenseType.updateMany({ where: { id: expenseTypeId, isActive: true }, data: { isActive: true } });
    const scoped = await tx.expenseTypeBranch.findUnique({
      where: { expenseTypeId_branchId: { expenseTypeId, branchId } },
      select: { expenseType: { select: { name: true } } },
    });
    if (!scoped) return { usable: false as const, reason: 'unavailable' as const };
    if (count === 0) return { usable: false as const, reason: 'inactive' as const };
    return { usable: true as const, name: scoped.expenseType.name };
  },
};

export type ExpenseTypeRow = NonNullable<Awaited<ReturnType<typeof expenseTypesRepository.findById>>>;
