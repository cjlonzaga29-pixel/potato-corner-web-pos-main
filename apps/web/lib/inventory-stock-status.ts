import type { BranchInventoryStockRow } from '@potato-corner/shared';

/**
 * POS-PERF-P47 — `?status=` filter the Supervisor dashboard cards link to.
 * Uses the row's own server-computed `status` (the same classification the
 * alerts endpoint uses), so a card's count always equals the rows shown.
 * POS-PERF-P48 — shared with the transfer page's stock-needs list so both
 * screens apply the one rule.
 *
 * POS-PERF-P56 — the server reports no-stock items as `status: 'critical'`
 * so older clients keep working; these helpers split out "out" from the
 * available figure, giving three buckets that never overlap. Only tracked
 * items reach these lists: the server leaves untracked items out.
 */
export const STOCK_STATUS_FILTERS = [
  { value: 'all', label: 'All items' },
  { value: 'alerts', label: 'Needs attention' },
  { value: 'out', label: 'Out of stock' },
  { value: 'critical', label: 'Critical' },
  { value: 'low', label: 'Low stock' },
] as const;
export type StockStatusFilter = (typeof STOCK_STATUS_FILTERS)[number]['value'];

export type StockState = 'out' | 'critical' | 'low' | 'healthy';

export function stockStateOf(row: Pick<BranchInventoryStockRow, 'quantity_available' | 'status'>): StockState {
  return row.quantity_available <= 0 ? 'out' : row.status;
}

/** StatusBadge value for a stock state (its inventory map knows `out_of_stock`). */
export function stockBadgeStatus(state: StockState): string {
  return state === 'out' ? 'out_of_stock' : state;
}

export function parseStockStatusFilter(raw: string | null): StockStatusFilter {
  return STOCK_STATUS_FILTERS.some((f) => f.value === raw) ? (raw as StockStatusFilter) : 'all';
}

export function matchesStockStatusFilter(row: BranchInventoryStockRow, filter: StockStatusFilter): boolean {
  if (filter === 'all') return true;
  const state = stockStateOf(row);
  if (filter === 'alerts') return state !== 'healthy';
  return state === filter;
}

const NEED_ORDER: Record<StockState, number> = { out: 0, critical: 1, low: 2, healthy: 3 };

/** Out-of-stock, critical and low rows (the "Needs attention" filter), emptiest first, then least available, then name. */
export function stockNeeds(rows: BranchInventoryStockRow[]): BranchInventoryStockRow[] {
  return rows
    .filter((row) => matchesStockStatusFilter(row, 'alerts'))
    .sort((a, b) => NEED_ORDER[stockStateOf(a)] - NEED_ORDER[stockStateOf(b)] || a.quantity_available - b.quantity_available || a.name.localeCompare(b.name));
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
