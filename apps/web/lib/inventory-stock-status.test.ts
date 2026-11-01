import { describe, expect, it } from 'vitest';
import type { BranchInventoryStockRow } from '@potato-corner/shared';
import { matchesStockStatusFilter, parseStockStatusFilter, stockBadgeStatus, stockNeeds, stockStateOf } from './inventory-stock-status';
import { affectedLabel, otherChoicesStillSell, recipeShortageLine, stockAlertCounts, stockAlertRows } from './inventory-stock-status';

function row(name: string, quantityAvailable: number, status: BranchInventoryStockRow['status']): BranchInventoryStockRow {
  return {
    inventory_item_id: name,
    name,
    sku: null,
    category_name: null,
    base_unit_id: 'unit',
    base_unit_code: 'g',
    quantity_on_hand: quantityAvailable,
    quantity_reserved: 0,
    quantity_available: quantityAvailable,
    low_stock_threshold: null,
    critical_threshold: null,
    status,
    consumed_today: 0,
    avg_unit_cost: null,
    inventory_value: null,
  };
}

describe('inventory stock states (POS-PERF-P56)', () => {
  it('splits no-stock rows out of critical without double counting', () => {
    const rows = [row('empty', 0, 'critical'), row('critical', 2, 'critical'), row('low', 5, 'low'), row('fine', 9, 'healthy')];
    expect(rows.filter((r) => matchesStockStatusFilter(r, 'out')).map((r) => r.name)).toEqual(['empty']);
    expect(rows.filter((r) => matchesStockStatusFilter(r, 'critical')).map((r) => r.name)).toEqual(['critical']);
    expect(rows.filter((r) => matchesStockStatusFilter(r, 'low')).map((r) => r.name)).toEqual(['low']);
    expect(rows.filter((r) => matchesStockStatusFilter(r, 'alerts'))).toHaveLength(3);
  });

  it('treats zero as out even when an older API still reports it healthy', () => {
    const rolledBack = row('empty', 0, 'healthy');
    expect(stockStateOf(rolledBack)).toBe('out');
    expect(matchesStockStatusFilter(rolledBack, 'alerts')).toBe(true);
    expect(stockBadgeStatus('out')).toBe('out_of_stock');
  });

  it('positive stock without thresholds is not a need', () => {
    expect(stockNeeds([row('fine', 1, 'healthy')])).toEqual([]);
  });

  it('lists transfer needs emptiest first, the same set as Needs attention', () => {
    const rows = [row('low', 5, 'low'), row('critical', 2, 'critical'), row('empty', 0, 'critical'), row('fine', 9, 'healthy')];
    expect(stockNeeds(rows).map((r) => r.name)).toEqual(['empty', 'critical', 'low']);
  });

  it('accepts the out filter from the URL and ignores unknown values', () => {
    expect(parseStockStatusFilter('out')).toBe('out');
    expect(parseStockStatusFilter('nope')).toBe('all');
  });
});

describe('recipe shortages (POS-PERF-P57)', () => {
  const shortage = {
    required: 40,
    deficit: 28,
    unit_code: 'g',
    affected: [
      { product_id: 'p', product_name: 'Fries', variant_id: 'v1', variant_name: 'Regular', choice_name: null, choice_kind: null, required: 20, deficit: 8, blocks_size: true },
      { product_id: 'p', product_name: 'Fries', variant_id: 'v2', variant_name: 'Large', choice_name: null, choice_kind: null, required: 40, deficit: 28, blocks_size: true },
    ],
  };

  it('an insufficient item is its own state: not out, not a threshold, and it outranks the thresholds', () => {
    expect(stockStateOf({ quantity_available: 12, status: 'healthy', recipe_shortage: shortage })).toBe('insufficient');
    expect(stockStateOf({ quantity_available: 12, status: 'low', recipe_shortage: shortage })).toBe('insufficient');
    expect(stockStateOf({ quantity_available: 0, status: 'critical', recipe_shortage: shortage })).toBe('out');
    // An older API sends no field.
    expect(stockStateOf({ quantity_available: 12, status: 'healthy' })).toBe('healthy');
  });

  it('merges both alert lists into unique items, and counts each once', () => {
    const rows = stockAlertRows({
      alerts: [
        { inventory_item_id: 'a', name: 'A', quantity_on_hand: 0, quantity_reserved: 0, quantity_available: 0, threshold: 0, severity: 'critical' },
        { inventory_item_id: 'b', name: 'B', quantity_on_hand: 5, quantity_reserved: 0, quantity_available: 5, threshold: 10, severity: 'low' },
      ],
      recipe_shortages: [{ inventory_item_id: 'c', name: 'C', quantity_on_hand: 12, quantity_reserved: 0, quantity_available: 12, unit_code: 'g', recipe_shortage: shortage }],
    });
    expect(rows.map((row) => row.inventory_item_id)).toEqual(['a', 'b', 'c']);
    expect(stockAlertCounts(rows)).toEqual({ out: 1, insufficient: 1, critical: 0, low: 1 });
    expect(stockAlertRows(undefined)).toEqual([]);
  });

  it('describes the shortage with units and affected sizes, each once', () => {
    expect(recipeShortageLine(12, shortage)).toBe('12 g available, 40 g needed for one serving, 28 g short');
    expect(affectedLabel(shortage)).toBe('Fries Regular; Fries Large');
    expect(otherChoicesStillSell(shortage)).toBe(false);
    expect(otherChoicesStillSell({ ...shortage, affected: [{ ...shortage.affected[0], choice_name: 'Cheese', choice_kind: 'flavor', blocks_size: false } as never] })).toBe(true);
    expect(affectedLabel({ ...shortage, affected: [{ ...shortage.affected[0], choice_name: 'Cheese', choice_kind: 'flavor' } as never] })).toBe('Fries Regular (Cheese)');
  });

  it('the Needs attention filter and the Insufficient filter both include it', () => {
    const row = { quantity_available: 12, status: 'healthy', recipe_shortage: shortage } as never;
    expect(matchesStockStatusFilter(row, 'alerts')).toBe(true);
    expect(matchesStockStatusFilter(row, 'insufficient')).toBe(true);
    expect(matchesStockStatusFilter(row, 'low')).toBe(false);
    expect(parseStockStatusFilter('insufficient')).toBe('insufficient');
  });
});
