import { describe, expect, it } from 'vitest';
import type { BranchInventoryStockRow } from '@potato-corner/shared';
import { matchesStockStatusFilter, parseStockStatusFilter, stockBadgeStatus, stockNeeds, stockStateOf } from './inventory-stock-status';

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
