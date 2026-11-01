import type { BranchInventoryStockRow, InventoryStockAlertListResponse, RecipeShortage } from '@potato-corner/shared';

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
 *
 * POS-PERF-P57 — "insufficient" is the fourth bucket: stock is positive but
 * can't cover one serving of something the POS offers (recipe_shortage, from
 * the same check as the POS). It outranks the thresholds because it is already
 * stopping sales. Against an older API the field is absent and nothing changes.
 */
export const STOCK_STATUS_FILTERS = [
  { value: 'all', label: 'All items' },
  { value: 'alerts', label: 'Needs attention' },
  { value: 'out', label: 'Out of stock' },
  { value: 'insufficient', label: 'Insufficient for a serving' },
  { value: 'critical', label: 'Critical' },
  { value: 'low', label: 'Low stock' },
] as const;
export type StockStatusFilter = (typeof STOCK_STATUS_FILTERS)[number]['value'];

export type StockState = 'out' | 'insufficient' | 'critical' | 'low' | 'healthy';

export function stockStateOf(row: Pick<BranchInventoryStockRow, 'quantity_available' | 'status' | 'recipe_shortage'>): StockState {
  if (row.quantity_available <= 0) return 'out';
  return row.recipe_shortage ? 'insufficient' : row.status;
}

/** StatusBadge value for a stock state (its inventory map knows `out_of_stock`). */
export function stockBadgeStatus(state: StockState): string {
  if (state === 'insufficient') return 'insufficient_for_serving';
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

const NEED_ORDER: Record<StockState, number> = { out: 0, insufficient: 1, critical: 2, low: 3, healthy: 4 };

/** Out-of-stock, insufficient, critical and low rows (the "Needs attention" filter), emptiest first, then least available, then name. */
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

/** POS-PERF-P57 — "Regular Fries Small; Chicken Pops Large (Cheese)". Each size or choice once. */
export function affectedLabel(shortage: RecipeShortage): string {
  const seen = new Set<string>();
  for (const entry of shortage.affected) {
    seen.add(`${entry.product_name} ${entry.variant_name}${entry.choice_name ? ` (${entry.choice_name})` : ''}`);
  }
  return [...seen].join('; ');
}

/** POS-PERF-P57 — "12 g available, 20 g needed for one serving, 8 g short". */
export function recipeShortageLine(available: number, shortage: RecipeShortage): string {
  const unit = shortage.unit_code;
  return `${available} ${unit} available, ${shortage.required} ${unit} needed for one serving, ${shortage.deficit} ${unit} short`;
}

/** POS-PERF-P57 — true when a flavor or add-on is short but every affected size still sells some other way. */
export function otherChoicesStillSell(shortage: RecipeShortage): boolean {
  return shortage.affected.every((entry) => !entry.blocks_size);
}

export type StockAlertRow = Pick<BranchInventoryStockRow, 'inventory_item_id' | 'name' | 'quantity_on_hand' | 'quantity_reserved' | 'quantity_available' | 'recipe_shortage'> & {
  status: BranchInventoryStockRow['status'];
  unit_code: string | undefined;
};

/**
 * POS-PERF-P57 — one list of unique items from the alerts response. Rows with a
 * recipe shortage but no threshold reached report status 'healthy', so they
 * land in the "insufficient" bucket only. An item is never listed twice however
 * many product sizes use it.
 */
export function stockAlertRows(data: Pick<InventoryStockAlertListResponse, 'alerts' | 'recipe_shortages'> | undefined): StockAlertRow[] {
  if (!data) return [];
  return [
    ...data.alerts.map((alert) => ({ ...alert, status: alert.severity })),
    ...(data.recipe_shortages ?? []).map((row) => ({ ...row, status: 'healthy' as const })),
  ].map((row) => ({
    inventory_item_id: row.inventory_item_id,
    name: row.name,
    quantity_on_hand: row.quantity_on_hand,
    quantity_reserved: row.quantity_reserved,
    quantity_available: row.quantity_available,
    recipe_shortage: row.recipe_shortage,
    status: row.status,
    unit_code: row.unit_code,
  }));
}

/** The four counts every summary shows, from the same rows. */
export function stockAlertCounts(rows: readonly StockAlertRow[]): Record<Exclude<StockState, 'healthy'>, number> {
  const counts = { out: 0, insufficient: 0, critical: 0, low: 0 };
  for (const row of rows) {
    const state = stockStateOf(row);
    if (state !== 'healthy') counts[state] += 1;
  }
  return counts;
}
