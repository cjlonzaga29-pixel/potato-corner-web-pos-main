import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { EXTRA_SUPPLY_MOVEMENT_REFERENCE } from '../universal-inventory/universal-inventory.types.js';
import type { CreateExtraSupplyData, IssueFilters, UpdateExtraSupplyData } from './extra-supplies.types.js';

const supplyInclude = {
  branches: { select: { branchId: true, branch: { select: { name: true } } } },
  inventoryItem: { select: { name: true, deletedAt: true, trackInventory: true, baseUnitId: true, unitCost: true } },
  enteredUnit: { select: { code: true } },
  baseUnit: { select: { code: true } },
} satisfies Prisma.ExtraSupplyInclude;

const issueInclude = {
  branch: { select: { name: true } },
  cashier: { select: { firstName: true, lastName: true } },
  lines: { include: { supply: { select: { name: true } } }, orderBy: { supplyName: 'asc' } },
} satisfies Prisma.ExtraSupplyIssueInclude;

type Client = Prisma.TransactionClient | typeof prisma;

function issueWhere(filters: IssueFilters): Prisma.ExtraSupplyIssueWhereInput {
  return {
    ...(filters.branchId ? { branchId: filters.branchId } : filters.branchIds !== 'all' ? { branchId: { in: filters.branchIds } } : {}),
    ...((filters.dateFrom || filters.dateTo) && { createdAt: { ...(filters.dateFrom && { gte: filters.dateFrom }), ...(filters.dateTo && { lt: filters.dateTo }) } }),
    ...(filters.kind && { kind: filters.kind }),
    ...(filters.cashierId && { cashierId: filters.cashierId }),
    ...(filters.extraSupplyId && { lines: { some: { extraSupplyId: filters.extraSupplyId } } }),
  };
}

/** The same filters as issueWhere, on the columns a line copies from its immutable issue. */
function lineWhere(filters: IssueFilters): Prisma.ExtraSupplyIssueLineWhereInput {
  return {
    ...(filters.branchId ? { branchId: filters.branchId } : filters.branchIds !== 'all' ? { branchId: { in: filters.branchIds } } : {}),
    ...((filters.dateFrom || filters.dateTo) && { createdAt: { ...(filters.dateFrom && { gte: filters.dateFrom }), ...(filters.dateTo && { lt: filters.dateTo }) } }),
    ...(filters.kind && { kind: filters.kind }),
    ...(filters.cashierId && { cashierId: filters.cashierId }),
    ...(filters.extraSupplyId && { extraSupplyId: filters.extraSupplyId }),
  };
}

/** POS-PERF-P61 — all Prisma calls for this module live here. */
export const extraSuppliesRepository = {
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait: number; timeout: number }) {
    return prisma.$transaction(work, options);
  },

  findMany(where: { branchIds?: string[]; includeInactive: boolean }) {
    return prisma.extraSupply.findMany({
      where: {
        ...(where.includeInactive ? {} : { isActive: true }),
        ...(where.branchIds && { branches: { some: { branchId: { in: where.branchIds } } } }),
      },
      include: supplyInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },

  findById(id: string, client: Client = prisma) {
    return client.extraSupply.findUnique({ where: { id }, include: supplyInclude });
  },

  findActiveBranchIds(branchIds: string[], client: Client = prisma) {
    return client.branch.findMany({ where: { id: { in: branchIds }, status: 'active' }, select: { id: true } });
  },

  findItemForConfig(inventoryItemId: string, client: Client = prisma) {
    return client.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      select: { id: true, name: true, baseUnitId: true, trackInventory: true, deletedAt: true, unitCost: true, baseUnit: { select: { code: true } } },
    });
  },

  findActiveUnit(unitId: string, client: Client = prisma) {
    return client.unitOfMeasure.findFirst({ where: { id: unitId, isActive: true }, select: { id: true, code: true } });
  },

  async countIssuesBySupply(ids: string[], branchIds: 'all' | string[], client: Client = prisma) {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await client.extraSupplyIssueLine.groupBy({
      by: ['extraSupplyId'],
      where: { extraSupplyId: { in: ids }, ...(branchIds !== 'all' && { branchId: { in: branchIds } }) },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.extraSupplyId, row._count._all]));
  },

  async create(data: CreateExtraSupplyData, branchIds: string[], tx: Prisma.TransactionClient) {
    const supply = await tx.extraSupply.create({ data });
    await tx.extraSupplyBranch.createMany({
      data: branchIds.map((branchId) => ({ extraSupplyId: supply.id, branchId, normalizedName: data.normalizedName, isActive: true })),
    });
    return tx.extraSupply.findUniqueOrThrow({ where: { id: supply.id }, include: supplyInclude });
  },

  /** Compare-and-swap on version. Holds the row until the caller's transaction ends, which is what orders a scope edit against an issue: see lockForIssue. */
  async compareAndUpdate(id: string, data: UpdateExtraSupplyData, expectedVersion: number, tx: Prisma.TransactionClient) {
    const { count } = await tx.extraSupply.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1;
  },

  branchesWithIssues(extraSupplyId: string, branchIds: string[], tx: Prisma.TransactionClient) {
    return tx.extraSupplyIssueLine.groupBy({ by: ['branchId'], where: { extraSupplyId, branchId: { in: branchIds } }, _count: { _all: true } });
  },

  async replaceScope(extraSupplyId: string, added: string[], removed: string[], tx: Prisma.TransactionClient) {
    if (removed.length > 0) await tx.extraSupplyBranch.deleteMany({ where: { extraSupplyId, branchId: { in: removed } } });
    if (added.length === 0) return;
    const { normalizedName, isActive } = await tx.extraSupply.findUniqueOrThrow({ where: { id: extraSupplyId }, select: { normalizedName: true, isActive: true } });
    await tx.extraSupplyBranch.createMany({ data: added.map((branchId) => ({ extraSupplyId, branchId, normalizedName, isActive })) });
  },

  /** Only ever touches this row: issues keep their snapshots. */
  async setActive(id: string, isActive: boolean, expectedVersion: number, actorId: string) {
    const { count } = await prisma.extraSupply.updateMany({
      where: { id, version: expectedVersion },
      data: { isActive, deactivatedAt: isActive ? null : new Date(), updatedById: actorId, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (count === 0) return null;
    return prisma.extraSupply.findUniqueOrThrow({ where: { id }, include: supplyInclude });
  },

  /** The image path is the only value written, so a failed replacement leaves every other field alone. */
  async compareAndSetImage(id: string, imagePath: string | null, expectedVersion: number, actorId: string) {
    const { count } = await prisma.extraSupply.updateMany({
      where: { id, version: expectedVersion },
      data: { imagePath, updatedById: actorId, version: { increment: 1 }, updatedAt: new Date() },
    });
    return count === 1;
  },

  terminalCards(branchId: string) {
    return prisma.extraSupply.findMany({
      where: { isActive: true, applyToPos: true, branches: { some: { branchId } }, inventoryItem: { deletedAt: null, trackInventory: true } },
      include: supplyInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },

  findStocks(branchId: string, inventoryItemIds: string[]) {
    return prisma.inventoryStock.findMany({
      where: { branchId, inventoryItemId: { in: inventoryItemIds } },
      select: { inventoryItemId: true, quantityOnHand: true, quantityReserved: true },
    });
  },

  // --- Issue, inside its transaction ---

  findOperation(id: string, client: Client = prisma) {
    return client.extraSupplyOperation.findUnique({ where: { id } });
  },

  createAbandonedOperation(id: string, branchId: string, cashierId: string, tx: Prisma.TransactionClient) {
    return tx.extraSupplyOperation.create({ data: { id, branchId, cashierId, status: 'abandoned' } });
  },

  /**
   * Holds each card's row until the issue commits. The update writes the value it
   * matched, so nothing changes and nothing cascades. Sorted, so two issues sharing
   * cards can't deadlock. A deactivation, price change or scope edit either commits
   * first and is seen by the read after this, or waits until the issue has committed.
   */
  async lockForIssue(supplyIds: string[], tx: Prisma.TransactionClient) {
    for (const id of [...supplyIds].sort()) {
      await tx.extraSupply.updateMany({ where: { id }, data: { version: { increment: 0 } } });
    }
    return tx.extraSupply.findMany({ where: { id: { in: supplyIds } }, include: supplyInclude });
  },

  /**
   * The one stock write: on-hand drops only while what remains still covers every
   * reservation, in a single statement. reserveStockForSale holds no advisory lock,
   * so this condition, not a prior read, is what keeps a sale's reservation whole.
   */
  async deductStock(branchId: string, inventoryItemId: string, quantity: Prisma.Decimal, tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<{ id: string; quantity_on_hand: Prisma.Decimal; unit_cost: Prisma.Decimal | null }[]>`
      UPDATE "inventory_stocks"
      SET "quantity_on_hand" = "quantity_on_hand" - ${quantity}, "version" = "version" + 1, "updated_at" = now()
      WHERE "branch_id" = ${branchId} AND "inventory_item_id" = ${inventoryItemId}
        AND "quantity_on_hand" - "quantity_reserved" >= ${quantity}
      RETURNING "id", "quantity_on_hand", "unit_cost"
    `;
    return rows[0] ?? null;
  },

  findStock(branchId: string, inventoryItemId: string, tx: Prisma.TransactionClient) {
    return tx.inventoryStock.findUnique({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
  },

  async createIssue(data: Prisma.ExtraSupplyIssueUncheckedCreateInput, lines: Prisma.ExtraSupplyIssueLineUncheckedCreateInput[], operation: { id: string; requestHash: string }, tx: Prisma.TransactionClient) {
    await tx.extraSupplyIssue.create({ data });
    await tx.extraSupplyIssueLine.createMany({ data: lines });
    await tx.extraSupplyOperation.create({
      data: { id: operation.id, branchId: data.branchId, cashierId: data.cashierId, requestHash: operation.requestHash, status: 'committed', issueId: data.id as string },
    });
  },

  // --- History ---

  findIssue(id: string, client: Client = prisma) {
    return client.extraSupplyIssue.findUnique({ where: { id }, include: issueInclude });
  },

  async findIssues(filters: IssueFilters, page: number, limit: number) {
    const where = issueWhere(filters);
    const [issues, total] = await Promise.all([
      prisma.extraSupplyIssue.findMany({ where, include: issueInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.extraSupplyIssue.count({ where }),
    ]);
    return { issues, total };
  },

  /** Newest first, one row past the limit so the caller can tell a complete export from a cut one. */
  findLinesForExport(filters: IssueFilters, take: number) {
    return prisma.extraSupplyIssueLine.findMany({
      where: lineWhere(filters),
      include: { issue: { select: { referenceNumber: true, reason: true, orderReference: true, cashier: { select: { firstName: true, lastName: true } }, branch: { select: { name: true } } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  },

  findMovements(issueId: string) {
    return prisma.inventoryStockMovement.findMany({
      where: { referenceType: EXTRA_SUPPLY_MOVEMENT_REFERENCE, referenceId: issueId },
      include: { inventoryItem: { select: { name: true } }, unit: { select: { code: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  countIssues(filters: IssueFilters) {
    return prisma.extraSupplyIssue.count({ where: issueWhere(filters) });
  },

  /** Every total comes from these, over the whole filtered period, whatever page is on screen. */
  groupLines(filters: IssueFilters) {
    return prisma.extraSupplyIssueLine.groupBy({
      by: ['branchId', 'extraSupplyId', 'cashierId', 'kind', 'paymentMethod', 'costSource'],
      where: lineWhere(filters),
      _sum: { quantity: true, lineAmount: true, lineCost: true },
      _count: { _all: true },
    });
  },

  findNames(branchIds: string[], supplyIds: string[], cashierIds: string[]) {
    return Promise.all([
      prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }),
      prisma.extraSupply.findMany({ where: { id: { in: supplyIds } }, select: { id: true, name: true } }),
      // POS-PERF-P66 — names come from Person, which outlives a deleted account.
      prisma.person.findMany({ where: { id: { in: cashierIds } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
  },

  /** Completed sales only, the same definition the shift's totals use. */
  async sumProductSales(filters: IssueFilters) {
    const result = await prisma.transaction.aggregate({
      where: {
        status: 'completed',
        ...(filters.branchId ? { branchId: filters.branchId } : filters.branchIds !== 'all' ? { branchId: { in: filters.branchIds } } : {}),
        ...((filters.dateFrom || filters.dateTo) && { createdAt: { ...(filters.dateFrom && { gte: filters.dateFrom }), ...(filters.dateTo && { lt: filters.dateTo }) } }),
        ...(filters.cashierId && { cashierId: filters.cashierId }),
      },
      _sum: { totalAmount: true },
    });
    return result._sum.totalAmount ?? new Prisma.Decimal(0);
  },
};

export type ExtraSupplyRow = NonNullable<Awaited<ReturnType<typeof extraSuppliesRepository.findById>>>;
export type ExtraSupplyIssueRow = NonNullable<Awaited<ReturnType<typeof extraSuppliesRepository.findIssue>>>;
