import type { Prisma } from '@prisma/client';
import { parseDiscountKey } from '@potato-corner/shared';

/**
 * POS-PERF-P59 — the sales one discount identity covers (see discountIdentityKey).
 * Shared by the Discount Report's aggregate, detail table, drill-down and exports
 * so their totals agree. An unreadable key matches nothing rather than everything.
 */
export function discountKeyWhere(discountKey: string | undefined): Prisma.TransactionWhereInput {
  if (!discountKey) return {};
  const parsed = parseDiscountKey(discountKey);
  if (!parsed) return { id: { in: [] } };
  return {
    discountType: parsed.discountType,
    ...(parsed.manualTypeId !== undefined && { manualDiscountTypeId: parsed.manualTypeId }),
  };
}
