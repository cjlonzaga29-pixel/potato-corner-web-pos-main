// apps/api/src/lib/reports/inventory-summary-export.test.ts
import { describe, it, expect } from 'vitest';
import type { InventorySummaryReportRow, WeightSummaryKg } from '@potato-corner/shared';
import { generateInventorySummaryCsv, generateInventorySummaryPdf, groupTotalsByUnit } from './inventory-summary-export.js';

function weightSummary(overrides: Partial<WeightSummaryKg>): WeightSummaryKg {
  return {
    opening_stock_kg: 0,
    consumed_today_kg: 0,
    consumed_this_month_kg: 0,
    remaining_kg: 0,
    included_item_count: 0,
    excluded_item_count: 0,
    ...overrides,
  };
}

function row(overrides: Partial<InventorySummaryReportRow>): InventorySummaryReportRow {
  return {
    ingredient_id: '11111111-1111-1111-1111-111111111111',
    ingredient_name: 'Test Item',
    branch_id: '22222222-2222-2222-2222-222222222222',
    branch_name: 'SM North',
    unit: 'g',
    opening_stock: 0,
    consumed_today: 0,
    consumed_this_month: 0,
    remaining_stock: 0,
    ...overrides,
  };
}

const rawFries = row({
  ingredient_name: 'Raw Fries',
  unit: 'kg',
  opening_stock: 12.5,
  consumed_today: 2.3,
  consumed_this_month: 54.1,
  remaining_stock: 10.2,
});

const cheesePowder = row({
  ingredient_name: 'Cheese Powder',
  unit: 'tbsp',
  opening_stock: 420,
  consumed_today: 18,
  consumed_this_month: 260,
  remaining_stock: 160,
});

const bbqPowder = row({
  ingredient_name: 'BBQ Powder',
  unit: 'tbsp',
  opening_stock: 380,
  consumed_today: 15,
  consumed_this_month: 210,
  remaining_stock: 170,
});

const salt = row({
  ingredient_name: 'Salt',
  unit: 'g',
  opening_stock: 250,
  consumed_today: 35,
  consumed_this_month: 920,
  remaining_stock: 215,
});

const vanillaExtract = row({
  ingredient_name: 'Vanilla Extract',
  unit: 'tsp',
  opening_stock: 100,
  consumed_today: 5,
  consumed_this_month: 40,
  remaining_stock: 90,
});

const cups = row({
  ingredient_name: 'Cups',
  unit: 'pcs',
  opening_stock: 300,
  consumed_today: 20,
  consumed_this_month: 240,
  remaining_stock: 240,
});

const allRows = [rawFries, cheesePowder, bbqPowder, salt, vanillaExtract, cups];

describe('groupTotalsByUnit', () => {
  it('groups rows by unit, in first-appearance order, and never mixes units together', () => {
    const totals = groupTotalsByUnit(allRows);

    expect(totals.map((t) => t.unit)).toEqual(['kg', 'tbsp', 'g', 'tsp', 'pcs']);
  });

  it('sums opening/consumed/remaining figures only across rows sharing the same unit', () => {
    const totals = groupTotalsByUnit(allRows);
    const tbspTotal = totals.find((t) => t.unit === 'tbsp');

    expect(tbspTotal).toEqual({
      unit: 'tbsp',
      opening_stock: 800,
      consumed_today: 33,
      consumed_this_month: 470,
      remaining_stock: 330,
    });
  });

  it('never folds a different unit into another unit\'s total', () => {
    const totals = groupTotalsByUnit(allRows);
    const kgTotal = totals.find((t) => t.unit === 'kg');
    const gTotal = totals.find((t) => t.unit === 'g');

    expect(kgTotal).toEqual({ unit: 'kg', opening_stock: 12.5, consumed_today: 2.3, consumed_this_month: 54.1, remaining_stock: 10.2 });
    expect(gTotal).toEqual({ unit: 'g', opening_stock: 250, consumed_today: 35, consumed_this_month: 920, remaining_stock: 215 });
  });
});

describe('generateInventorySummaryCsv', () => {
  it('renders a single "Ingredient Consumption" table with every row in its own inventory unit — tbsp, tsp, g, and kg all appear', () => {
    const csv = generateInventorySummaryCsv(allRows).toString('utf-8');

    expect(csv).toContain('Ingredient Consumption');
    expect(csv).toContain('Ingredient,Unit,Opening Stock,Consumed Today,Consumed This Month,Remaining');
    expect(csv).toContain('Raw Fries,kg,12.5,2.3,54.1,10.2');
    expect(csv).toContain('Cheese Powder,tbsp,420,18,260,160');
    expect(csv).toContain('BBQ Powder,tbsp,380,15,210,170');
    expect(csv).toContain('Salt,g,250,35,920,215');
    expect(csv).toContain('Vanilla Extract,tsp,100,5,40,90');
  });

  it('never attempts any unit conversion — values are byte-identical to the input row values', () => {
    const csv = generateInventorySummaryCsv([rawFries]).toString('utf-8');

    // No "kg" suffix column duplication, no separate converted figure — just
    // the raw stored value next to the item's own unit.
    expect(csv).toContain('Raw Fries,kg,12.5,2.3,54.1,10.2');
    expect(csv).not.toContain('Status');
    expect(csv).not.toContain('CONVERSION_REQUIRED');
    expect(csv).not.toContain('missing unit conversions');
  });

  it('renders one Total line per unit, grouped by unit, never mixing units together', () => {
    const csv = generateInventorySummaryCsv(allRows).toString('utf-8');
    const lines = csv.split('\n');

    expect(lines).toContain('Total (kg),,12.5,2.3,54.1,10.2');
    expect(lines).toContain('Total (tbsp),,800,33,470,330');
    expect(lines).toContain('Total (g),,250,35,920,215');
    expect(lines).toContain('Total (tsp),,100,5,40,90');
    expect(lines).toContain('Total (pcs),,300,20,240,240');
  });

  it('includes a packaging item (pcs) in the same single table as ingredients, not a separate section', () => {
    const csv = generateInventorySummaryCsv(allRows).toString('utf-8');

    expect(csv).toContain('Cups,pcs,300,20,240,240');
    expect(csv).not.toContain('Packaging Consumption');
  });
});

describe('generateInventorySummaryCsv — TOTAL INGREDIENT WEIGHT (KG) (TASK 149)', () => {
  it('appends a TOTAL INGREDIENT WEIGHT (KG) section with the four kg totals when weightSummaryKg is supplied', () => {
    const csv = generateInventorySummaryCsv(
      [rawFries, cheesePowder],
      weightSummary({ opening_stock_kg: 12.796, consumed_today_kg: 2.426, consumed_this_month_kg: 55.92, remaining_kg: 10.312, included_item_count: 2 }),
    ).toString('utf-8');

    expect(csv).toContain('TOTAL INGREDIENT WEIGHT (KG)');
    expect(csv).toContain('Opening Stock (KG),Consumed Today (KG),Consumed This Month (KG),Remaining (KG)');
    expect(csv).toContain('12.796,2.426,55.92,10.312');
  });

  it('appends the missing-conversion warning only when excluded_item_count > 0', () => {
    const withWarning = generateInventorySummaryCsv([cheesePowder], weightSummary({ excluded_item_count: 1 })).toString('utf-8');
    const withoutWarning = generateInventorySummaryCsv([cheesePowder], weightSummary({ excluded_item_count: 0 })).toString('utf-8');

    expect(withWarning).toContain('Some non-count ingredients are excluded from the KG total because no weight conversion is configured.');
    expect(withoutWarning).not.toContain('excluded from the KG total');
  });

  it('omits the KG section entirely when weightSummaryKg is not supplied — the existing native-unit CSV is untouched', () => {
    const csv = generateInventorySummaryCsv(allRows).toString('utf-8');

    expect(csv).not.toContain('TOTAL INGREDIENT WEIGHT (KG)');
  });
});

describe('generateInventorySummaryPdf', () => {
  it('renders a non-empty PDF buffer starting with the %PDF magic bytes for a mix of tbsp, tsp, g, kg, and pcs rows', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, allRows, 'SM North');

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders a non-empty PDF buffer with no rows', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, [], null);

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});

describe('generateInventorySummaryPdf — Total Ingredient Weight (KG) (TASK 149)', () => {
  it('renders a larger, still-valid PDF when weightSummaryKg is supplied — the KG table/warning add content', async () => {
    const withoutKg = await generateInventorySummaryPdf({ page: 1, limit: 25 }, allRows, 'SM North');
    const withKg = await generateInventorySummaryPdf(
      { page: 1, limit: 25 },
      allRows,
      'SM North',
      weightSummary({
        opening_stock_kg: 12.796,
        consumed_today_kg: 2.426,
        consumed_this_month_kg: 55.92,
        remaining_kg: 10.312,
        included_item_count: 5,
        excluded_item_count: 1,
      }),
    );

    expect(withKg.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    expect(withKg.length).toBeGreaterThan(withoutKg.length);
  });

  it('renders a valid PDF for a KG summary with no excluded items and with no native rows at all', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, [], null, weightSummary({ included_item_count: 0, excluded_item_count: 0 }));

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
