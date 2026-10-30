import type { BranchInventoryStockRow } from '@potato-corner/shared';

/**
 * POS-PERF-P47 — `?status=` filter the Supervisor dashboard cards link to.
 * Uses the row's own server-computed `status` (the same classification the
 * alerts endpoint uses), so a card's count always equals the rows shown.
 * POS-PERF-P48 — shared with the transfer page's stock-needs list so both
 * screens apply the one rule.
 */
export const STOCK_STATUS_FILTERS = [
  { value: 'all', label: 'All items' },
  { value: 'alerts', label: 'Needs attention' },
  { value: 'low', label: 'Low stock' },
  { value: 'critical', label: 'Critical' },
] as const;
export type StockStatusFilter = (typeof STOCK_STATUS_FILTERS)[number]['value'];

export function parseStockStatusFilter(raw: string | null): StockStatusFilter {
  return STOCK_STATUS_FILTERS.some((f) => f.value === raw) ? (raw as StockStatusFilter) : 'all';
}

export function matchesStockStatusFilter(row: BranchInventoryStockRow, filter: StockStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'alerts') return row.status !== 'healthy';
  return row.status === filter;
}

const NEED_ORDER: Record<BranchInventoryStockRow['status'], number> = { critical: 0, low: 1, healthy: 2 };

/** Low + critical rows (the "Needs attention" filter), critical first, then least available, then name. */
export function stockNeeds(rows: BranchInventoryStockRow[]): BranchInventoryStockRow[] {
  return rows
    .filter((row) => matchesStockStatusFilter(row, 'alerts'))
    .sort((a, b) => NEED_ORDER[a.status] - NEED_ORDER[b.status] || a.quantity_available - b.quantity_available || a.name.localeCompare(b.name));
}

/**
 * Shortfall up to the low-stock threshold, measured against *available*
 * (on hand minus reserved) — the same figure the status is judged on.
 * Null when no low threshold is configured or nothing is short.
 */
export function shortfallToLowThreshold(row: BranchInventoryStockRow): number | null {
  if (row.low_stock_threshold === null) return null;
  const gap = Math.round((row.low_stock_threshold - row.quantity_available) * 1000) / 1000;
  return gap > 0 ? gap : null;
}
