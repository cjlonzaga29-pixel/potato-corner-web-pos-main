// apps/api/src/lib/reports/inventory-summary-export.test.ts
import { describe, it, expect } from 'vitest';
import type { IngredientWeightKgRow, PackagingPcRow } from '@potato-corner/shared';
import { generateInventorySummaryCsv, generateInventorySummaryPdf, type InventorySummarySplit } from './inventory-summary-export.js';

function kgRow(overrides: Partial<IngredientWeightKgRow>): IngredientWeightKgRow {
  return {
    ingredient_id: '11111111-1111-1111-1111-111111111111',
    ingredient_name: 'Test Ingredient',
    branch_id: '22222222-2222-2222-2222-222222222222',
    branch_name: 'SM North',
    unit_code: 'g',
    opening_stock: 0,
    consumed_today: 0,
    consumed_this_month: 0,
    remaining: 0,
    opening_stock_kg: 0,
    consumed_today_kg: 0,
    consumed_this_month_kg: 0,
    remaining_kg: 0,
    status: 'converted',
    ...overrides,
  };
}

function pcRow(overrides: Partial<PackagingPcRow>): PackagingPcRow {
  return {
    ingredient_id: '33333333-3333-3333-3333-333333333333',
    ingredient_name: 'Test Packaging',
    branch_id: '22222222-2222-2222-2222-222222222222',
    branch_name: 'SM North',
    opening_stock_pc: 0,
    consumed_today_pc: 0,
    consumed_this_month_pc: 0,
    remaining_pc: 0,
    ...overrides,
  };
}

const rawFries = kgRow({
  ingredient_name: 'Raw Fries',
  unit_code: 'g',
  opening_stock: 12500,
  consumed_today: 2300,
  consumed_this_month: 54100,
  remaining: 10200,
  opening_stock_kg: 12.5,
  consumed_today_kg: 2.3,
  consumed_this_month_kg: 54.1,
  remaining_kg: 10.2,
  status: 'converted',
});
const cheesePowder = kgRow({
  ingredient_name: 'Cheese Powder',
  unit_code: 'tbsp',
  opening_stock: 42,
  consumed_today: 18,
  consumed_this_month: 260,
  remaining: 160,
  opening_stock_kg: 0.294,
  consumed_today_kg: 0.126,
  consumed_this_month_kg: 1.82,
  remaining_kg: 1.12,
  status: 'converted',
});
const mysteryPowder = kgRow({
  ingredient_name: 'Mystery Powder',
  unit_code: 'tbsp',
  opening_stock: 50,
  consumed_today: 0,
  consumed_this_month: 0,
  remaining: 50,
  opening_stock_kg: null,
  consumed_today_kg: null,
  consumed_this_month_kg: null,
  remaining_kg: null,
  status: 'conversion_needed',
});

const regularCup = pcRow({ ingredient_name: 'Regular Cup', opening_stock_pc: 300, consumed_today_pc: 20, consumed_this_month_pc: 240, remaining_pc: 240 });
const kraftBag = pcRow({ ingredient_name: 'Kraft Bag No. 2', opening_stock_pc: 500, consumed_today_pc: 40, consumed_this_month_pc: 300, remaining_pc: 460 });

function split(overrides: Partial<InventorySummarySplit> = {}): InventorySummarySplit {
  return {
    ingredientWeightKg: [],
    packagingPc: [],
    ingredientWeightTotalsKg: { opening_stock_kg: 0, consumed_today_kg: 0, consumed_this_month_kg: 0, remaining_kg: 0 },
    packagingTotalsPc: { opening_stock_pc: 0, consumed_today_pc: 0, consumed_this_month_pc: 0, remaining_pc: 0 },
    excludedIngredientCount: 0,
    ...overrides,
  };
}

const fullSplit = split({
  ingredientWeightKg: [rawFries, cheesePowder],
  packagingPc: [regularCup, kraftBag],
  ingredientWeightTotalsKg: { opening_stock_kg: 12.794, consumed_today_kg: 2.426, consumed_this_month_kg: 55.92, remaining_kg: 11.32 },
  packagingTotalsPc: { opening_stock_pc: 800, consumed_today_pc: 60, consumed_this_month_pc: 540, remaining_pc: 700 },
});

describe('generateInventorySummaryCsv', () => {
  it('renders exactly two sections — Ingredient Weight Consumption (KG) then Packaging Consumption (PC)', () => {
    const csv = generateInventorySummaryCsv(fullSplit).toString('utf-8');

    expect(csv).toContain('Ingredient Weight Consumption (KG)');
    expect(csv).toContain('Packaging Consumption (PC)');
    expect(csv.indexOf('Ingredient Weight Consumption (KG)')).toBeLessThan(csv.indexOf('Packaging Consumption (PC)'));
  });

  it('renders KG rows with the Ingredient/Base Unit/native/KG/Status header', () => {
    const csv = generateInventorySummaryCsv(fullSplit).toString('utf-8');

    expect(csv).toContain(
      'Ingredient,Base Unit,Opening Stock,Consumed Today,Consumed This Month,Remaining,Opening Stock (KG),Consumed Today (KG),Consumed This Month (KG),Remaining (KG),Status',
    );
    expect(csv).toContain('Raw Fries,g,12500,2300,54100,10200,12.5,2.3,54.1,10.2,Converted');
    expect(csv).toContain('Cheese Powder,tbsp,42,18,260,160,0.294,0.126,1.82,1.12,Converted');
  });

  it('never hides a row lacking a KG conversion — shows native columns, "—" in KG columns, and Conversion Needed status', () => {
    const csv = generateInventorySummaryCsv(split({ ingredientWeightKg: [mysteryPowder], excludedIngredientCount: 1 })).toString('utf-8');

    expect(csv).toContain('Mystery Powder,tbsp,50,0,0,50,—,—,—,—,Conversion Needed');
  });

  it('renders PC rows with the Packaging header and no g/kg/tbsp/tsp rows mixed in', () => {
    const csv = generateInventorySummaryCsv(fullSplit).toString('utf-8');

    expect(csv).toContain('Packaging,Opening Stock (PC),Consumed Today (PC),Consumed This Month (PC),Remaining (PC)');
    expect(csv).toContain('Regular Cup,300,20,240,240');
    expect(csv).toContain('Kraft Bag No. 2,500,40,300,460');
  });

  it('renders one Total row per table, matching each table\'s totals', () => {
    const csv = generateInventorySummaryCsv(fullSplit).toString('utf-8');
    const lines = csv.split('\n');

    expect(lines).toContain('Total,,,,,,12.794,2.426,55.92,11.32,');
    expect(lines).toContain('Total,800,60,540,700');
  });

  it('never renders the old mixed native-unit table or its per-unit totals', () => {
    const csv = generateInventorySummaryCsv(fullSplit).toString('utf-8');

    expect(csv).not.toContain('Ingredient Consumption');
    expect(csv).not.toContain('Ingredient,Unit,Opening Stock,Consumed Today');
    expect(csv).not.toContain('Total (kg)');
    expect(csv).not.toContain('Total (pcs)');
  });

  it('appends the missing-conversion warning only when excludedIngredientCount > 0', () => {
    const withWarning = generateInventorySummaryCsv(split({ excludedIngredientCount: 1 })).toString('utf-8');
    const withoutWarning = generateInventorySummaryCsv(split({ excludedIngredientCount: 0 })).toString('utf-8');

    expect(withWarning).toContain('Some ingredients have no weight conversion configured');
    expect(withoutWarning).not.toContain('no weight conversion configured');
  });
});

describe('generateInventorySummaryPdf', () => {
  it('renders a non-empty PDF buffer starting with the %PDF magic bytes for a mix of KG and PC rows', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, fullSplit, 'SM North');

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders a non-empty, valid PDF with no rows in either table', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, split(), null);

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders a larger PDF when items are excluded (the warning line adds content)', async () => {
    const withoutWarning = await generateInventorySummaryPdf({ page: 1, limit: 25 }, fullSplit, 'SM North');
    const withWarning = await generateInventorySummaryPdf({ page: 1, limit: 25 }, { ...fullSplit, excludedIngredientCount: 1 }, 'SM North');

    expect(withWarning.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    expect(withWarning.length).toBeGreaterThan(withoutWarning.length);
  });
});
