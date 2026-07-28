import ExcelJS from 'exceljs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateWorkbook } from './generate-inventory-workbook';

let tmpDir: string;

function row(cols: string[]): string {
  return cols.join(',');
}

function getSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`Expected worksheet "${name}" to exist`);
  return sheet;
}

function writeFixtures(dir: string) {
  const ingredientsRows = Array.from({ length: 31 }, (_, i) =>
    row(['', `Item ${i + 1}`, 'RAW_MATERIAL', '', '', '', i === 0 ? 'optional' : '']),
  );
  writeFileSync(
    path.join(dir, 'ingredients-template.csv'),
    ['branch_name,inventory_item_name,item_type,stock_unit,cost_per_unit,reorder_level,notes', ...ingredientsRows].join('\n'),
  );

  const productBomRows = Array.from({ length: 33 }, (_, i) =>
    row(['', 'Flavored Fries', 'Regular', `Item ${i + 1}`, 'BASE', '', '', 'YES', '']),
  );
  writeFileSync(
    path.join(dir, 'product-bom-template.csv'),
    ['branch_name,product_name,variant_name,inventory_item_name,mapping_type,quantity_required,unit,required_from_user,notes', ...productBomRows].join(
      '\n',
    ),
  );

  const flavorBomRows = Array.from({ length: 48 }, (_, i) =>
    row(['', 'Flavored Fries', 'Regular', 'Cheese', `Item ${i + 1}`, '', '', 'YES', '']),
  );
  writeFileSync(
    path.join(dir, 'flavor-bom-template.csv'),
    [
      'branch_name,product_name,variant_name,flavor_name,inventory_item_name,quantity_required,unit,required_from_user,notes',
      ...flavorBomRows,
    ].join('\n'),
  );

  const mixMaxRows = Array.from({ length: 21 }, (_, i) => row(['Large Mix', '1', 'Snack 1', 'Flavored Fries', '', 'TRUE', `row ${i + 1}`]));
  writeFileSync(
    path.join(dir, 'mix-max-snack-options-template.csv'),
    ['mix_variant,slot_index,slot_label,allowed_snack_product,allowed_snack_variant,required,notes', ...mixMaxRows].join('\n'),
  );

  const openingStockRows = Array.from({ length: 31 }, (_, i) => row(['', `Item ${i + 1}`, '', '', '', '', '']));
  writeFileSync(
    path.join(dir, 'opening-stock-template.csv'),
    ['branch_name,inventory_item_name,opening_quantity,unit,unit_cost,effective_date,notes', ...openingStockRows].join('\n'),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'inventory-workbook-'));
  writeFixtures(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateWorkbook', () => {
  it('creates all seven sheets with expected names', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    await generateWorkbook(tmpDir, outputPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const names = workbook.worksheets.map((s) => s.name);
    expect(names).toEqual(['Instructions', 'Ingredients', 'Product BOM', 'Flavor BOM', 'Mix Max Options', 'Opening Stock', 'Validation Summary']);
  });

  it('preserves CSV row counts per sheet', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    const result = await generateWorkbook(tmpDir, outputPath);
    expect(result.rowCounts).toEqual({
      ingredients: 31,
      productBom: 33,
      flavorBom: 48,
      mixMax: 21,
      openingStock: 31,
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    expect(getSheet(workbook, 'Ingredients').rowCount - 1).toBe(31);
    expect(getSheet(workbook, 'Product BOM').rowCount - 1).toBe(33);
    expect(getSheet(workbook, 'Opening Stock').rowCount - 1).toBe(31);
  });

  it('creates exactly 21 Mix Max rows', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    await generateWorkbook(tmpDir, outputPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    expect(getSheet(workbook, 'Mix Max Options').rowCount - 1).toBe(21);
  });

  it('creates exactly 48 Flavor BOM rows', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    await generateWorkbook(tmpDir, outputPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    expect(getSheet(workbook, 'Flavor BOM').rowCount - 1).toBe(48);
  });

  it('preserves exact catalog names from source rows', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    await generateWorkbook(tmpDir, outputPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = getSheet(workbook, 'Mix Max Options');
    expect(sheet.getRow(2).getCell(1).value).toBe('Large Mix');
    expect(sheet.getRow(2).getCell(4).value).toBe('Flavored Fries');
  });

  it('adds required data validations', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    await generateWorkbook(tmpDir, outputPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);

    const ingredients = getSheet(workbook, 'Ingredients');
    const itemTypeCell = ingredients.getRow(2).getCell(3);
    expect(itemTypeCell.dataValidation?.type).toBe('list');

    const mixMax = getSheet(workbook, 'Mix Max Options');
    const variantCell = mixMax.getRow(2).getCell(5);
    expect(variantCell.dataValidation?.type).toBe('list');

    const openingStock = getSheet(workbook, 'Opening Stock');
    const dateCell = openingStock.getRow(2).getCell(6);
    expect(dateCell.dataValidation?.type).toBe('date');
  });

  it('adds blank-cell summary formulas on the Validation Summary sheet', async () => {
    const outputPath = path.join(tmpDir, 'out.xlsx');
    await generateWorkbook(tmpDir, outputPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const summary = getSheet(workbook, 'Validation Summary');
    let foundFormula = false;
    summary.eachRow((r) => {
      r.eachCell((c) => {
        if (typeof c.value === 'object' && c.value && 'formula' in (c.value as object)) foundFormula = true;
      });
    });
    expect(foundFormula).toBe(true);
    expect(summary.getRow(1).getCell(1).value).toBe('Workbook Status: INCOMPLETE');
  });

  it('fails clearly when a source CSV is missing', async () => {
    rmSync(path.join(tmpDir, 'ingredients-template.csv'));
    await expect(generateWorkbook(tmpDir, path.join(tmpDir, 'out.xlsx'))).rejects.toThrow(/ingredients-template\.csv/);
  });

  it('does not modify source CSV files', async () => {
    const before = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');
    await generateWorkbook(tmpDir, path.join(tmpDir, 'out.xlsx'));
    const after = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');
    expect(after).toBe(before);
  });
});
