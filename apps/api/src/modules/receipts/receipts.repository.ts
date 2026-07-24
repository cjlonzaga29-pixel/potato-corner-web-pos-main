import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const receiptInclude = {
  items: true,
  branch: { select: { name: true } },
} satisfies Prisma.TransactionInclude;

/**
 * Receipts repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const receiptsRepository = {
  findByTransactionNumber(transactionNumber: string) {
    return prisma.transaction.findUnique({ where: { transactionNumber }, include: receiptInclude });
  },
};
