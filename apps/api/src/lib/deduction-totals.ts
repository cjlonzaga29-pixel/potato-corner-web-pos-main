import type { BomDeductionLine } from '../modules/shadow-bom-deduction/shadow-bom-deduction.types.js';

export interface DeductionTotal {
  quantity: number;
  baseUnitId: string;
}

/**
 * Sums per-inventory-item quantities across a set of BOM deduction lines.
 * Shared by transactions.service.ts#reserveStockForSale (reserving against
 * the freshly-resolved cart's deduction lines at checkout time) and
 * inventory-deduction.service.ts (recomputing the same totals later from
 * TransactionItem.deductionSnapshot, which stores the identical
 * {inventoryItemId, quantity, baseUnitId} shape per line) — both must use
 * the exact same aggregation so the quantity reserved at checkout always
 * equals the quantity the worker later actually deducts.
 */
export function computeDeductionTotals(items: { lines: BomDeductionLine[] }[]): Map<string, DeductionTotal> {
  const totals = new Map<string, DeductionTotal>();
  for (const item of items) {
    for (const line of item.lines) {
      const existing = totals.get(line.inventoryItemId);
      totals.set(line.inventoryItemId, { quantity: (existing?.quantity ?? 0) + line.quantity, baseUnitId: line.baseUnitId });
    }
  }
  return totals;
}

/** Deterministic ascending order by inventoryItemId — every pass over a totals map (locks, reads, writes) must use this same order so two operations touching an overlapping item set serialize instead of risking a Postgres deadlock. */
export function sortedDeductionTotalEntries(totals: Map<string, DeductionTotal>): [string, DeductionTotal][] {
  return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
