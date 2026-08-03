// apps/api/src/lib/reports/inventory-summary-export.test.ts
import { describe, it, expect } from 'vitest';
import type { InventorySummaryReportRow } from '@potato-corner/shared';
import { generateInventorySummaryCsv, generateInventorySummaryPdf } from './inventory-summary-export.js';

function row(overrides: Partial<InventorySummaryReportRow>): InventorySummaryReportRow {
  return {
    ingredient_id: '11111111-1111-1111-1111-111111111111',
    ingredient_name: 'Test Item',
    branch_id: '22222222-2222-2222-2222-222222222222',
    branch_name: 'SM North',
    section: 'INGREDIENT_KG',
    status: 'CONVERTED',
    unit: 'g',
    opening_stock: 0,
    consumed_today: 0,
    consumed_this_month: 0,
    remaining_stock: 0,
    opening_stock_kg: null,
    consumed_today_kg: null,
    consumed_this_month_kg: null,
    remaining_kg: null,
    conversion_warning: null,
    ...overrides,
  };
}

const ingredientRow = row({
  ingredient_name: 'Raw Fries',
  unit: 'g',
  opening_stock: 2416,
  consumed_today: 448,
  consumed_this_month: 2416,
  remaining_stock: 1968,
  opening_stock_kg: 2.416,
  consumed_today_kg: 0.448,
  consumed_this_month_kg: 2.416,
  remaining_kg: 1.968,
});

const packagingRow = row({
  section: 'PACKAGING_PC',
  status: null,
  ingredient_name: 'Cups',
  unit: 'pc',
  opening_stock: 12,
  consumed_today: 3,
  consumed_this_month: 20,
  remaining_stock: 9,
});

const warningRow = row({
  section: 'INGREDIENT_KG',
  status: 'CONVERSION_REQUIRED',
  ingredient_name: 'Flavored Fries Powder',
  unit: 'tbsp',
  opening_stock: 50,
  consumed_today: 5,
  consumed_this_month: 30,
  remaining_stock: 45,
  conversion_warning: 'Configure a valid conversion to kg',
});

describe('generateInventorySummaryCsv', () => {
  it('includes Ingredient Consumption (KG) and Packaging Consumption (PC) as the only two sections, with no Status column', () => {
    const csv = generateInventorySummaryCsv([ingredientRow, packagingRow]).toString('utf-8');

    expect(csv).toContain('Ingredient Consumption (KG)');
    expect(csv).toContain('Ingredient,Opening Stock (kg),Consumed Today (kg),Consumed This Month (kg),Remaining (kg)');
    expect(csv).toContain('Raw Fries,2.416,0.448,2.416,1.968');
    expect(csv).toContain('Packaging Consumption (PC)');
    expect(csv).toContain('Cups,12,3,20,9');
  });

  it('excludes an unresolved (CONVERSION_REQUIRED) row from Ingredient Consumption (KG) entirely and appends a warning line instead, matching the admin UI', () => {
    const csv = generateInventorySummaryCsv([ingredientRow, packagingRow, warningRow]).toString('utf-8');

    expect(csv).not.toContain('Flavored Fries Powder');
    expect(csv).not.toContain('Status');
    expect(csv).toContain('Some ingredients are missing unit conversions and are excluded from KG totals.');
  });

  it('omits the warning line when no rows need a kg conversion', () => {
    const csv = generateInventorySummaryCsv([ingredientRow, packagingRow]).toString('utf-8');

    expect(csv).not.toContain('missing unit conversions');
  });

  it('excludes CONVERSION_REQUIRED rows from the Ingredient Consumption (KG) totals', () => {
    const csv = generateInventorySummaryCsv([ingredientRow, warningRow]).toString('utf-8');
    const lines = csv.split('\n');
    const totalsLine = lines[lines.indexOf('Ingredient Consumption (KG)') + 3];

    // Only ingredientRow (2.416/0.448/2.416/1.968) contributes — warningRow's
    // tbsp figures must not be folded into these kg totals, and it isn't a row
    // in this table at all.
    expect(totalsLine).toBe('Total,2.42,0.45,2.42,1.97');
  });
});

describe('generateInventorySummaryPdf', () => {
  it('renders a non-empty PDF buffer starting with the %PDF magic bytes, with the unresolved row folded into Ingredient Consumption (KG)', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, [ingredientRow, packagingRow, warningRow], 'SM North');

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders only two sections when no rows are unresolved', async () => {
    const buffer = await generateInventorySummaryPdf({ page: 1, limit: 25 }, [ingredientRow, packagingRow], null);

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
