import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pairKey(branchId: string, inventoryItemId: string): string {
  return `${branchId}::${inventoryItemId}`;
}

/**
 * Resolves the *current* unit cost for each (branchId, inventoryItemId) pair
 * — InventoryStock.unitCost for that branch first, InventoryItem.unitCost as
 * the branch-agnostic fallback, null when neither exists (Simple Operational
 * Audit §3's preferred resolution order). Batched across branches/items so
 * multi-branch admin aggregation costs one query pair, not N.
 */
export async function resolveCurrentUnitCosts(
  pairs: { branchId: string; inventoryItemId: string }[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (pairs.length === 0) return result;

  const branchIds = [...new Set(pairs.map((p) => p.branchId))];
  const itemIds = [...new Set(pairs.map((p) => p.inventoryItemId))];

  const [stocks, items] = await Promise.all([
    prisma.inventoryStock.findMany({
      where: { branchId: { in: branchIds }, inventoryItemId: { in: itemIds } },
      select: { branchId: true, inventoryItemId: true, unitCost: true },
    }),
    prisma.inventoryItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, unitCost: true },
    }),
  ]);

  const itemCostById = new Map(items.map((i) => [i.id, i.unitCost?.toNumber() ?? null]));
  const stockCostByKey = new Map(stocks.map((s) => [pairKey(s.branchId, s.inventoryItemId), s.unitCost?.toNumber() ?? null]));

  for (const pair of pairs) {
    const key = pairKey(pair.branchId, pair.inventoryItemId);
    const stockCost = stockCostByKey.get(key);
    result.set(key, stockCost ?? itemCostById.get(pair.inventoryItemId) ?? null);
  }
  return result;
}

/** One line of a TransactionItem.deductionSnapshot JSON array, after cost capture was added. */
export interface DeductionSnapshotLine {
  inventoryItemId: string;
  quantity: number;
  baseUnitId?: string;
  /** Unit cost captured at checkout time — null when no InventoryStock/InventoryItem cost existed yet. */
  componentUnitCost?: number | null;
  /** componentUnitCost * quantity, precomputed at checkout — the exact cost this line consumed at sale time. */
  componentCost?: number | null;
}

/**
 * Attaches componentUnitCost/componentCost to each deduction line for a cart
 * about to be checked out, so COGS can later be read straight from the
 * snapshot instead of re-estimating from (possibly since-changed) current
 * cost. Purely additive to the existing snapshot shape — safe for every
 * historical-snapshot reader (reverseInventoryForTransaction discriminates
 * on `'inventoryItemId' in entry`, which stays true).
 */
export async function attachCostToDeductionLines<T extends { inventoryItemId: string; quantity: number }>(
  branchId: string,
  lines: T[],
): Promise<(T & { componentUnitCost: number | null; componentCost: number | null })[]> {
  const pairs = [...new Set(lines.map((l) => l.inventoryItemId))].map((inventoryItemId) => ({ branchId, inventoryItemId }));
  const costs = await resolveCurrentUnitCosts(pairs);
  return lines.map((line) => {
    const unitCost = costs.get(pairKey(branchId, line.inventoryItemId)) ?? null;
    return {
      ...line,
      componentUnitCost: unitCost,
      componentCost: unitCost !== null ? round2(unitCost * line.quantity) : null,
    };
  });
}

export interface CogsResult {
  cogs: number;
  /** True when any component's cost had to be estimated from current cost (no point-in-time capture) or was unavailable entirely. */
  isEstimated: boolean;
  /** Count of TransactionItem rows where at least one component's cost could not be resolved at all (captured or current). */
  missingCostItemCount: number;
}

/**
 * COGS for a set of completed-sale TransactionItem rows. Prefers each line's
 * captured componentCost; falls back to *current* stock/item cost for rows
 * written before cost capture existed (marking the whole result an estimate,
 * per the audit's "Estimated Net Profit" rule — a current-cost fallback is
 * never point-in-time accurate). Never treats a missing cost as zero without
 * flagging it via isEstimated/missingCostItemCount.
 */
export async function computeCogsForItems(
  items: { branchId: string; deductionSnapshot: Prisma.JsonValue | null }[],
): Promise<CogsResult> {
  const fallbackPairs: { branchId: string; inventoryItemId: string }[] = [];
  const seenPairs = new Set<string>();

  const parsedItems = items.map((item) => {
    const lines = Array.isArray(item.deductionSnapshot) ? (item.deductionSnapshot as unknown as DeductionSnapshotLine[]) : null;
    if (lines) {
      for (const line of lines) {
        const key = pairKey(item.branchId, line.inventoryItemId);
        if ((line.componentCost === undefined || line.componentCost === null) && !seenPairs.has(key)) {
          seenPairs.add(key);
          fallbackPairs.push({ branchId: item.branchId, inventoryItemId: line.inventoryItemId });
        }
      }
    }
    return { branchId: item.branchId, lines };
  });

  const fallbackCosts = await resolveCurrentUnitCosts(fallbackPairs);

  let cogs = 0;
  let isEstimated = false;
  let missingCostItemCount = 0;

  for (const { branchId, lines } of parsedItems) {
    // No snapshot at all (pre-dates the deductionSnapshot column entirely) —
    // cost cannot be attributed to any component; flag as missing rather
    // than silently contributing zero to a "definitive" total.
    if (!lines || lines.length === 0) {
      isEstimated = true;
      missingCostItemCount += 1;
      continue;
    }

    let itemMissing = false;
    for (const line of lines) {
      if (line.componentCost !== undefined && line.componentCost !== null) {
        cogs += line.componentCost;
        continue;
      }
      isEstimated = true;
      const unitCost = fallbackCosts.get(pairKey(branchId, line.inventoryItemId)) ?? null;
      if (unitCost === null) {
        itemMissing = true;
        continue;
      }
      cogs += unitCost * line.quantity;
    }
    if (itemMissing) missingCostItemCount += 1;
  }

  return { cogs: round2(cogs), isEstimated, missingCostItemCount };
}
