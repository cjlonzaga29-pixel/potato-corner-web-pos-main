import { describe, expect, it } from 'vitest';
import type { PosCatalogProduct } from '@potato-corner/shared';
import { stockShortageDetail, stockShortageLabel, unsellableVariants } from './pos-product-availability';

type Variant = PosCatalogProduct['variants'][number];
type Shortage = NonNullable<Variant['stock_shortages']>[number];

function shortage(overrides: Partial<Shortage>): Shortage {
  return { inventory_item_id: 'i', name: 'Cheese', reason: 'no_stock', available: 0, required: 10, unit_code: 'g', track_inventory: true, ...overrides };
}

function variant(overrides: Partial<Variant>): Variant {
  return { id: 'v', name: 'Large', live_ready: true, readiness_code: 'READY', blocking_issues: [], stock_status: 'in_stock', stock_shortages: [], ...overrides } as Variant;
}

function product(variants: Variant[]): PosCatalogProduct {
  return { id: 'p', name: 'Fries', variants } as unknown as PosCatalogProduct;
}

describe('POS product availability reasons (POS-PERF-P56)', () => {
  it('names the ingredient for each kind of shortage', () => {
    const detail = (s: Partial<Shortage>) => stockShortageDetail(variant({ stock_status: 'out_of_stock', stock_shortages: [shortage(s)] }));
    expect(detail({ reason: 'no_stock' })).toBe('Cheese is out of stock.');
    expect(detail({ reason: 'fully_reserved', available: 0 })).toBe('Cheese is fully reserved by pending sales.');
    expect(detail({ reason: 'below_recipe_quantity', available: 5 })).toBe('Cheese: 5 g available, 10 g needed for one.');
    expect(detail({ reason: 'not_assigned' })).toBe('Cheese is not assigned to this branch.');
    expect(detail({ track_inventory: false })).toContain('not tracked');
  });

  it('gives no shortage text unless confirmed out of stock, or when an older API sent no reason', () => {
    expect(stockShortageLabel(variant({ stock_status: 'low_stock' }))).toBeNull();
    expect(stockShortageLabel(variant({ stock_status: 'unknown' }))).toBeNull();
    expect(stockShortageLabel(variant({ stock_status: 'out_of_stock', stock_shortages: undefined }))).toBeNull();
    expect(stockShortageLabel(variant({ stock_status: 'out_of_stock', stock_shortages: [shortage({})] }))).toBe('Short: Cheese');
  });

  it('tells an ingredient shortage from a setup problem and skips sellable sizes', () => {
    const result = unsellableVariants([
      product([
        variant({ id: 'ok' }),
        variant({ id: 'low', stock_status: 'low_stock' }),
        variant({ id: 'short', stock_status: 'out_of_stock', stock_shortages: [shortage({})] }),
        variant({ id: 'setup', live_ready: false, readiness_code: 'MISSING_BASE_MAPPING', stock_status: 'unknown', blocking_issues: [{ code: 'INVENTORY_STOCK_MISSING', severity: 'blocking', message: 'Salt is not assigned.', flavor_name: null }] as Variant['blocking_issues'] }),
      ]),
    ]);
    expect(result.map((v) => [v.key, v.kind, v.reason])).toEqual([
      ['short', 'stock', 'Cheese is out of stock.'],
      ['setup', 'setup', 'Salt is not assigned.'],
    ]);
  });
});
