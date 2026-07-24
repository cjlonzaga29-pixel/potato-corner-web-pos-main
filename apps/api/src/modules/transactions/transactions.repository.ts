import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { TransactionListFilters } from './transactions.types.js';
import type { DiscountAuditFilters } from './transactions.types.js';

const transactionInclude = {
  items: true,
  shift: { select: { id: true, status: true, branchId: true } },
} satisfies Prisma.TransactionInclude;

const holdOrderInclude = {
  items: true,
} satisfies Prisma.HoldOrderInclude;

interface CreateHoldOrderRow {
  branchId: string;
  shiftId: string;
  cashierId: string;
  expiresAt: Date;
  items: {
    productId: string;
    productVariantId: string;
    flavorId: string | null;
    productName: string;
    variantName: string;
    flavorName: string | null;
    unitPrice: number;
    quantity: number;
  }[];
}

interface CreateTransactionRow {
  branchId: string;
  shiftId: string;
  cashierId: string;
  receiptNumber: string;
  paymentMethod: 'cash' | 'gcash';
  subtotal: number;
  discountAmount: number;
  discountType: string | null;
  discountCustomerIdEncrypted: string | null;
  discountCustomerIdHash: string | null;
  vatAmount: number;
  vatExemptAmount: number;
  totalAmount: number;
  cashTendered: number | null;
  changeAmount: number | null;
  gcashReference: string | null;
  gcashManuallyVerified: boolean | null;
  isOfflineTransaction: boolean;
  offlineProvisionalNumber: string | null;
  items: {
    productId: string;
    productVariantId: string;
    flavorId: string | null;
    productName: string;
    variantName: string;
    flavorName: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    recipeVersion: number;
  }[];
}

function buildListWhere(filters: TransactionListFilters): Prisma.TransactionWhereInput {
  return {
    ...(filters.branchId && { branchId: filters.branchId }),
    ...(filters.shiftId && { shiftId: filters.shiftId }),
    ...(filters.status && { status: filters.status }),
    ...(filters.paymentMethod && { paymentMethod: filters.paymentMethod }),
    ...((filters.dateFrom || filters.dateTo) && {
      createdAt: {
        ...(filters.dateFrom && { gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) }),
        ...(filters.dateTo && { lte: new Date(`${filters.dateTo}T23:59:59.999Z`) }),
      },
    }),
  };
}

/**
 * Transactions repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const transactionsRepository = {
  findDiscountAuditTrail(filters: DiscountAuditFilters) {
    const where: Prisma.TransactionWhereInput = {
      discountType: { not: null },
      ...(filters.branchIds !== 'all' ? { branchId: { in: filters.branchIds } } : {}),
      ...(filters.discountType ? { discountType: filters.discountType } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? { createdAt: { ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}), ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}) } }
        : {}),
    };
    return Promise.all([
      prisma.transaction.findMany({
        where,
        select: {
          id: true,
          branchId: true,
          transactionNumber: true,
          discountType: true,
          discountAmount: true,
          discountCustomerIdEncrypted: true,
          discountCustomerIdHash: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.transaction.count({ where }),
    ]).then(([rows, total]) => ({ rows, total }));
  },

  findBranch(branchId: string) {
    return prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, code: true, status: true } });
  },

  /** Batch lookup for cart pricing/validation — one query for every distinct variant in the cart. */
  findVariantsForSale(variantIds: string[]) {
    return prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: {
        product: { select: { id: true, name: true, status: true } },
        variantFlavors: { include: { flavor: { select: { id: true, name: true, isActive: true } } } },
      },
    });
  },

  findBranchProductAvailabilityMap(branchId: string, productIds: string[]) {
    return prisma.branchProductAvailability.findMany({
      where: { branchId, productId: { in: productIds } },
      select: { productId: true, isAvailable: true },
    });
  },

  findBranchFlavorAvailabilityMap(branchId: string, flavorIds: string[]) {
    return prisma.branchFlavorAvailability.findMany({
      where: { branchId, flavorId: { in: flavorIds } },
      select: { flavorId: true, isAvailable: true },
    });
  },

  /** Sequence source for the BIR receipt number — resets daily per branch because the prefix embeds the date. */
  countTransactionsWithPrefix(prefix: string) {
    return prisma.transaction.count({ where: { transactionNumber: { startsWith: prefix } } });
  },

  /**
   * Transaction row + its line items are created atomically — a crash
   * partway through must never leave a transaction with zero items.
   */
  async createTransaction(data: CreateTransactionRow, tx?: Prisma.TransactionClient) {
    const run = async (client: Prisma.TransactionClient) => {
      const transaction = await client.transaction.create({
        data: {
          branchId: data.branchId,
          shiftId: data.shiftId,
          cashierId: data.cashierId,
          transactionNumber: data.receiptNumber,
          paymentMethod: data.paymentMethod,
          subtotal: data.subtotal,
          discountAmount: data.discountAmount,
          discountType: data.discountType,
          discountCustomerIdEncrypted: data.discountCustomerIdEncrypted,
          discountCustomerIdHash: data.discountCustomerIdHash,
          vatAmount: data.vatAmount,
          vatExemptAmount: data.vatExemptAmount,
          totalAmount: data.totalAmount,
          amountTendered: data.cashTendered,
          changeAmount: data.changeAmount,
          gcashReference: data.gcashReference,
          gcashManuallyVerified: data.gcashManuallyVerified,
          isOfflineTransaction: data.isOfflineTransaction,
          offlineProvisionalNumber: data.offlineProvisionalNumber,
        },
      });

      await client.transactionItem.createMany({
        data: data.items.map((item) => ({
          transactionId: transaction.id,
          productId: item.productId,
          productVariantId: item.productVariantId,
          flavorId: item.flavorId,
          productNameSnapshot: item.productName,
          variantNameSnapshot: item.variantName,
          flavorNameSnapshot: item.flavorName,
          unitPriceSnapshot: item.unitPrice,
          quantity: item.quantity,
          lineTotal: item.lineTotal,
          recipeVersion: item.recipeVersion,
        })),
      });

      return client.transaction.findUniqueOrThrow({ where: { id: transaction.id }, include: transactionInclude });
    };
    if (tx) return run(tx);
    return prisma.$transaction(run);
  },

  findTransactionById(id: string) {
    return prisma.transaction.findUnique({ where: { id }, include: transactionInclude });
  },

  async listTransactions(filters: TransactionListFilters) {
    const where = buildListWhere(filters);
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: transactionInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.transaction.count({ where }),
    ]);
    return { transactions, total };
  },

  voidTransaction(id: string, data: { voidedById: string; voidReason: string }, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.transaction.update({
      where: { id },
      data: { status: 'voided', voidedAt: new Date(), voidedById: data.voidedById, voidReason: data.voidReason },
      include: transactionInclude,
    });
  },

  refundTransaction(id: string, data: { refundedById: string; refundReason: string }, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.transaction.update({
      where: { id },
      data: { status: 'refunded', refundedAt: new Date(), refundedById: data.refundedById, refundReason: data.refundReason },
      include: transactionInclude,
    });
  },

  markReceiptPrinted(id: string) {
    return prisma.transaction.update({ where: { id }, data: { receiptPrinted: true }, include: transactionInclude });
  },

  /**
   * One row per shift closed inside [dayStart, dayEnd], with its voided
   * transactions and its discounted-and-completed transactions. Backs
   * fraud rules 1 (excessive voids), 2 (discount abuse), 6 (end of shift
   * void), and 7 (employee self-discount frequency) — each rule filters
   * this same shape differently rather than four near-duplicate queries.
   */
  findClosedShiftTransactionSummaries(branchId: string, dayStart: Date, dayEnd: Date) {
    return prisma.shift.findMany({
      where: { branchId, status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: {
        id: true,
        cashierId: true,
        closedAt: true,
        transactions: {
          where: { OR: [{ status: 'voided' }, { status: 'completed', discountType: { not: null } }] },
          select: { id: true, status: true, discountType: true, voidedAt: true },
        },
      },
    });
  },

  /** Per-cashier GCash transaction count for one day — the "actual" side of rule 4's anomaly comparison. */
  async findGcashCountsByCashierForDate(branchId: string, dayStart: Date, dayEnd: Date) {
    const rows = await prisma.transaction.groupBy({
      by: ['cashierId'],
      where: { branchId, paymentMethod: 'gcash', status: 'completed', createdAt: { gte: dayStart, lte: dayEnd } },
      _count: { _all: true },
    });
    return rows.map((row) => ({ cashierId: row.cashierId, gcashCount: row._count._all }));
  },

  /** Total branch-wide GCash transaction count over a trailing window — the denominator for rule 4's daily average. */
  countGcashTransactionsForBranchWindow(branchId: string, windowStart: Date, windowEnd: Date) {
    return prisma.transaction.count({
      where: { branchId, paymentMethod: 'gcash', status: 'completed', createdAt: { gte: windowStart, lte: windowEnd } },
    });
  },

  /** Every statutory-discount transaction with a hash in the trailing window, across all branches — rule 5 groups these by hash itself (Corrections #4: this rule is global-scope, not per-branch). */
  findStatutoryDiscountsInWindow(windowStart: Date, windowEnd: Date) {
    return prisma.transaction.findMany({
      where: {
        status: 'completed',
        discountType: { in: ['pwd', 'senior_citizen'] },
        discountCustomerIdHash: { not: null },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true, branchId: true, cashierId: true, discountCustomerIdHash: true, createdAt: true },
    });
  },

  /** 3-per-terminal limit (Architecture doc §Part 8) — "terminal" mapped to active shift, see transactions.types.ts. */
  countActiveHoldOrdersForShift(shiftId: string) {
    return prisma.holdOrder.count({ where: { shiftId, status: 'held' } });
  },

  async createHoldOrder(data: CreateHoldOrderRow) {
    return prisma.$transaction(async (tx) => {
      const holdOrder = await tx.holdOrder.create({
        data: {
          branchId: data.branchId,
          shiftId: data.shiftId,
          cashierId: data.cashierId,
          expiresAt: data.expiresAt,
        },
      });

      await tx.holdOrderItem.createMany({
        data: data.items.map((item) => ({
          holdOrderId: holdOrder.id,
          productId: item.productId,
          productVariantId: item.productVariantId,
          flavorId: item.flavorId,
          productNameSnapshot: item.productName,
          variantNameSnapshot: item.variantName,
          flavorNameSnapshot: item.flavorName,
          unitPriceSnapshot: item.unitPrice,
          quantity: item.quantity,
        })),
      });

      return tx.holdOrder.findUniqueOrThrow({ where: { id: holdOrder.id }, include: holdOrderInclude });
    });
  },

  findHoldOrderById(id: string) {
    return prisma.holdOrder.findUnique({ where: { id }, include: holdOrderInclude });
  },

  listActiveHoldOrdersForShift(shiftId: string) {
    return prisma.holdOrder.findMany({
      where: { shiftId, status: 'held' },
      include: holdOrderInclude,
      orderBy: { createdAt: 'asc' },
    });
  },

  releaseHoldOrder(id: string) {
    return prisma.holdOrder.update({
      where: { id },
      data: { status: 'released', releasedAt: new Date() },
      include: holdOrderInclude,
    });
  },

  /**
   * Only transitions rows still `held` — a hold already released between the
   * expiry job firing and this write must not be overwritten back to
   * `expired`. Returns the updated count so the worker can tell a genuine
   * expiry apart from a harmless no-op race against a concurrent release.
   */
  expireHoldOrderIfStillHeld(id: string) {
    return prisma.holdOrder.updateMany({
      where: { id, status: 'held' },
      data: { status: 'expired', expiredAt: new Date() },
    });
  },
};
