// POS-PERF-P62 — read-only database checks for the browser driver. Refuses anything
// but this task's local p62_browser database.
import { createRequire } from 'node:module';

const url = new URL(process.env.DATABASE_URL ?? 'missing://');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/p62_browser' || process.env.PRODUCTION_DATABASE_URL_DIRECT) {
  throw new Error('Refusing: DATABASE_URL is not the local p62_browser database');
}
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
export const prisma = new PrismaClient({ log: [] });

export async function mainBranchId() {
  return (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN01' } })).id;
}

/** Sales and supply issues at MAIN01 created after `since`, with their stock effects. */
export async function activitySince(since) {
  const branchId = await mainBranchId();
  const transactions = await prisma.transaction.findMany({ where: { branchId, createdAt: { gte: since } }, select: { id: true, transactionNumber: true, totalAmount: true, discountAmount: true, paymentMethod: true, status: true, idempotencyKey: true, inventoryDeductionStatus: true } });
  const saleMovements = await prisma.inventoryStockMovement.count({ where: { branchId, createdAt: { gte: since }, referenceType: { not: null }, referenceId: { in: transactions.map((t) => t.id) } } });
  const issues = await prisma.extraSupplyIssue.findMany({ where: { branchId, createdAt: { gte: since } }, include: { lines: true } });
  return {
    transactions: transactions.map((t) => ({ ...t, totalAmount: Number(t.totalAmount), discountAmount: Number(t.discountAmount) })),
    saleMovements,
    issues: issues.map((i) => ({ id: i.id, kind: i.kind, paymentMethod: i.paymentMethod, amountCollected: Number(i.amountCollected ?? 0), lines: i.lines.length })),
  };
}

export async function supplyStock(itemId) {
  const branchId = await mainBranchId();
  const row = await prisma.inventoryStock.findFirst({ where: { branchId, inventoryItemId: itemId } });
  return row ? Number(row.quantityOnHand) : null;
}
