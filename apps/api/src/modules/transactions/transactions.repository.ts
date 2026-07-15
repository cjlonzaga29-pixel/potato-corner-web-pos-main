import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { TransactionListFilters } from './transactions.types.js';

const transactionInclude = {
  items: true,
  shift: { select: { id: true, status: true, branchId: true } },
} satisfies Prisma.TransactionInclude;

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
  async createTransaction(data: CreateTransactionRow) {
    return prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
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

      await tx.transactionItem.createMany({
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
        })),
      });

      return tx.transaction.findUniqueOrThrow({ where: { id: transaction.id }, include: transactionInclude });
    });
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

  voidTransaction(id: string, data: { voidedById: string; voidReason: string }) {
    return prisma.transaction.update({
      where: { id },
      data: { status: 'voided', voidedAt: new Date(), voidedById: data.voidedById, voidReason: data.voidReason },
      include: transactionInclude,
    });
  },

  refundTransaction(id: string, data: { refundedById: string; refundReason: string }) {
    return prisma.transaction.update({
      where: { id },
      data: { status: 'refunded', refundedAt: new Date(), refundedById: data.refundedById, refundReason: data.refundReason },
      include: transactionInclude,
    });
  },

  markReceiptPrinted(id: string) {
    return prisma.transaction.update({ where: { id }, data: { receiptPrinted: true }, include: transactionInclude });
  },
};
