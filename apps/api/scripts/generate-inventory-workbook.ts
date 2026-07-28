// Generates docs/inventory-setup/potato-corner-master-bom.xlsx from the
// validated CSV templates in docs/inventory-setup/. Workbook generation
// only: no database access, no imports, no invented business values.
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETUP_DIR, FILES, parseCsv } from './validate-inventory-setup';

export const DEFAULT_OUTPUT_PATH = path.resolve(DEFAULT_SETUP_DIR, 'potato-corner-master-bom.xlsx');

const FLAVOR_NAMES = ['Cheese', 'BBQ', 'Sour Cream', 'White Cheddar', 'Sour Cheese', 'Chili BBQ', 'Chili Cheese', 'Sweet Corn'];
const STOCK_UNITS = ['g', 'kg', 'ml', 'L', 'pc', 'pack', 'bottle', 'tbsp'];
const ITEM_TYPES = ['RAW_MATERIAL', 'PACKAGING', 'FINISHED_GOOD', 'SEASONING'];
const MAPPING_TYPES = ['BASE', 'PACKAGING', 'FINISHED_GOOD'];
const YES_NO = ['YES', 'NO'];
const TRUE_FALSE = ['TRUE', 'FALSE'];
const SNACK_PRODUCTS = ['Flavored Fries', 'Loopys', 'Crunchy Chicken Pops'];
const SNACK_VARIANTS = ['Regular', 'Large', 'Jumbo', 'Mega', 'Giga', 'Tera'];

const EXPECTED_ROW_COUNTS: Record<keyof typeof FILES, number> = {
  ingredients: 31,
  productBom: 33,
  flavorBom: 48,
  mixMax: 21,
  openingStock: 31,
};

const REQUIRED_HEADERS: Record<keyof typeof FILES, string[]> = {
  ingredients: ['branch_name', 'inventory_item_name', 'item_type', 'stock_unit', 'cost_per_unit', 'reorder_level'],
  productBom: ['branch_name', 'product_name', 'variant_name', 'inventory_item_name', 'mapping_type', 'quantity_required', 'unit', 'required_from_user'],
  flavorBom: ['branch_name', 'product_name', 'variant_name', 'flavor_name', 'inventory_item_name', 'quantity_required', 'unit', 'required_from_user'],
  mixMax: ['mix_variant', 'slot_index', 'slot_label', 'allowed_snack_product', 'allowed_snack_variant', 'required'],
  openingStock: ['branch_name', 'inventory_item_name', 'opening_quantity', 'unit', 'unit_cost', 'effective_date'],
};

// Columns highlighted as required user-entry cells, per sheet. Mix Max's
// source CSV has no branch_name column, so only columns that actually exist
// in the template are highlighted (see docs/inventory-setup/README.md).
const REQUIRED_INPUT_COLUMNS: Record<keyof typeof FILES, string[]> = {
  ingredients: ['branch_name', 'stock_unit', 'cost_per_unit', 'reorder_level'],
  productBom: ['branch_name', 'quantity_required', 'unit', 'required_from_user'],
  flavorBom: ['branch_name', 'quantity_required', 'unit', 'required_from_user'],
  mixMax: ['allowed_snack_variant'],
  openingStock: ['branch_name', 'opening_quantity', 'unit', 'unit_cost', 'effective_date'],
};

const SHEET_TITLES: Record<keyof typeof FILES, string> = {
  ingredients: 'Ingredients',
  productBom: 'Product BOM',
  flavorBom: 'Flavor BOM',
  mixMax: 'Mix Max Options',
  openingStock: 'Opening Stock',
};

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5233' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
const ALT_ROW_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const REQUIRED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
};

interface LoadedCsv {
  fileName: string;
  headers: string[];
  rows: string[][];
}

function loadCsv(baseDir: string, key: keyof typeof FILES): LoadedCsv {
  const fileName = FILES[key];
  const filePath = path.join(baseDir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Required source CSV is missing: ${filePath}`);
  }
  const text = readFileSync(filePath, 'utf8');
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new Error(`Source CSV is empty: ${fileName}`);
  }
  const headers = table[0].map((h) => h.trim());
  for (const required of REQUIRED_HEADERS[key]) {
    if (!headers.includes(required)) {
      throw new Error(`Source CSV "${fileName}" is missing required header "${required}".`);
    }
  }
  const rows = table.slice(1).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  return { fileName, headers, rows };
}

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function styleHeaderRow(sheet: ExcelJS.Worksheet, columnCount: number) {
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    if (colNumber > columnCount) return;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = THIN_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } };
}

function applyRowStyling(
  sheet: ExcelJS.Worksheet,
  headers: string[],
  rowCount: number,
  highlightColumns: string[],
  wrapColumns: string[] = ['notes'],
) {
  const highlightIdx = new Set(headers.map((h, i) => (highlightColumns.includes(h) ? i : -1)).filter((i) => i >= 0));
  const wrapIdx = new Set(headers.map((h, i) => (wrapColumns.includes(h) ? i : -1)).filter((i) => i >= 0));

  for (let r = 0; r < rowCount; r += 1) {
    const excelRow = sheet.getRow(r + 2);
    const isAlt = r % 2 === 1;
    for (let c = 0; c < headers.length; c += 1) {
      const cell = excelRow.getCell(c + 1);
      cell.border = THIN_BORDER;
      if (highlightIdx.has(c)) {
        cell.fill = REQUIRED_FILL;
        cell.protection = { locked: false };
      } else if (isAlt) {
        cell.fill = ALT_ROW_FILL;
        cell.protection = { locked: false };
      } else {
        cell.protection = { locked: false };
      }
      if (wrapIdx.has(c)) {
        cell.alignment = { wrapText: true, vertical: 'top' };
      } else {
        cell.alignment = { ...cell.alignment, vertical: 'middle' };
      }
    }
  }
}

function setColumnWidths(sheet: ExcelJS.Worksheet, headers: string[]) {
  headers.forEach((h, i) => {
    let width = Math.max(14, h.length + 4);
    if (h === 'notes') width = 40;
    if (h.includes('name')) width = Math.max(width, 20);
    sheet.getColumn(i + 1).width = width;
  });
}

function addListValidation(sheet: ExcelJS.Worksheet, headers: string[], columnName: string, options: string[], rowCount: number) {
  const idx = headers.indexOf(columnName);
  if (idx === -1) return;
  const col = columnLetter(idx);
  for (let r = 0; r < rowCount; r += 1) {
    sheet.getCell(`${col}${r + 2}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${options.join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Invalid value',
      error: `Value must be one of: ${options.join(', ')}`,
    };
  }
}

function addDecimalValidation(
  sheet: ExcelJS.Worksheet,
  headers: string[],
  columnName: string,
  rowCount: number,
  operator: 'greaterThanOrEqual' | 'greaterThan',
  bound: number,
) {
  const idx = headers.indexOf(columnName);
  if (idx === -1) return;
  const col = columnLetter(idx);
  for (let r = 0; r < rowCount; r += 1) {
    sheet.getCell(`${col}${r + 2}`).dataValidation = {
      type: 'decimal',
      operator,
      formulae: [bound],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Invalid number',
      error: operator === 'greaterThanOrEqual' ? 'Value must be a non-negative number.' : 'Value must be a positive number.',
    };
  }
}

function addDateValidation(sheet: ExcelJS.Worksheet, headers: string[], columnName: string, rowCount: number) {
  const idx = headers.indexOf(columnName);
  if (idx === -1) return;
  const col = columnLetter(idx);
  for (let r = 0; r < rowCount; r += 1) {
    const cell = sheet.getCell(`${col}${r + 2}`);
    cell.dataValidation = {
      type: 'date',
      operator: 'between',
      formulae: ['DATE(2000,1,1)', 'DATE(2100,12,31)'],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Invalid date',
      error: 'Value must be a valid date between 2000-01-01 and 2100-12-31.',
    };
    cell.numFmt = 'yyyy-mm-dd';
  }
}

function buildDataSheet(workbook: ExcelJS.Workbook, key: keyof typeof FILES, csv: LoadedCsv) {
  const sheet = workbook.addWorksheet(SHEET_TITLES[key]);
  sheet.addRow(csv.headers);
  for (const row of csv.rows) {
    sheet.addRow(row);
  }
  styleHeaderRow(sheet, csv.headers.length);
  setColumnWidths(sheet, csv.headers);
  applyRowStyling(sheet, csv.headers, csv.rows.length, REQUIRED_INPUT_COLUMNS[key]);
  return sheet;
}

function buildIngredientsSheet(workbook: ExcelJS.Workbook, csv: LoadedCsv) {
  const sheet = buildDataSheet(workbook, 'ingredients', csv);
  addListValidation(sheet, csv.headers, 'item_type', ITEM_TYPES, csv.rows.length);
  addListValidation(sheet, csv.headers, 'stock_unit', STOCK_UNITS, csv.rows.length);
  addDecimalValidation(sheet, csv.headers, 'cost_per_unit', csv.rows.length, 'greaterThanOrEqual', 0);
  addDecimalValidation(sheet, csv.headers, 'reorder_level', csv.rows.length, 'greaterThanOrEqual', 0);
  return sheet;
}

function buildProductBomSheet(workbook: ExcelJS.Workbook, csv: LoadedCsv) {
  const sheet = buildDataSheet(workbook, 'productBom', csv);
  addListValidation(sheet, csv.headers, 'mapping_type', MAPPING_TYPES, csv.rows.length);
  addListValidation(sheet, csv.headers, 'required_from_user', YES_NO, csv.rows.length);
  addListValidation(sheet, csv.headers, 'unit', STOCK_UNITS, csv.rows.length);
  addDecimalValidation(sheet, csv.headers, 'quantity_required', csv.rows.length, 'greaterThan', 0);
  return sheet;
}

function buildFlavorBomSheet(workbook: ExcelJS.Workbook, csv: LoadedCsv) {
  const sheet = buildDataSheet(workbook, 'flavorBom', csv);
  addListValidation(sheet, csv.headers, 'flavor_name', FLAVOR_NAMES, csv.rows.length);
  addListValidation(sheet, csv.headers, 'required_from_user', YES_NO, csv.rows.length);
  addListValidation(sheet, csv.headers, 'unit', STOCK_UNITS, csv.rows.length);
  addDecimalValidation(sheet, csv.headers, 'quantity_required', csv.rows.length, 'greaterThan', 0);
  return sheet;
}

function buildMixMaxSheet(workbook: ExcelJS.Workbook, csv: LoadedCsv) {
  const sheet = buildDataSheet(workbook, 'mixMax', csv);
  addListValidation(sheet, csv.headers, 'allowed_snack_product', SNACK_PRODUCTS, csv.rows.length);
  addListValidation(sheet, csv.headers, 'allowed_snack_variant', SNACK_VARIANTS, csv.rows.length);
  addListValidation(sheet, csv.headers, 'required', TRUE_FALSE, csv.rows.length);
  return sheet;
}

function buildOpeningStockSheet(workbook: ExcelJS.Workbook, csv: LoadedCsv) {
  const sheet = buildDataSheet(workbook, 'openingStock', csv);
  addListValidation(sheet, csv.headers, 'unit', STOCK_UNITS, csv.rows.length);
  addDecimalValidation(sheet, csv.headers, 'opening_quantity', csv.rows.length, 'greaterThanOrEqual', 0);
  addDecimalValidation(sheet, csv.headers, 'unit_cost', csv.rows.length, 'greaterThanOrEqual', 0);
  addDateValidation(sheet, csv.headers, 'effective_date', csv.rows.length);
  return sheet;
}

function buildInstructionsSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet('Instructions');
  sheet.getColumn(1).width = 100;

  const titleRow = sheet.addRow(['Potato Corner Master BOM — Setup Instructions']);
  titleRow.getCell(1).font = { bold: true, size: 16 };
  sheet.addRow([]);

  const lines = [
    'These CSV-derived sheets are for entering real ingredient, packaging, and serving quantities before any',
    'inventory/BOM database records are created. No data has been imported and no migration has been applied.',
    '',
    'How to fill this workbook in:',
    '1. Fill in all highlighted (pale yellow) required cells. Do not leave a highlighted cell blank.',
    '2. Use exact catalog names for products, variants, flavors, and inventory items — do not rename them.',
    '3. Quantities represent usage for one completed sale (i.e. consumption per single unit sold).',
    '4. Use consistent units: g for dry ingredients, ml for liquids, pc for packaging and finished goods.',
    '5. The Mix & Max parent BOM (Product BOM sheet) contains packaging only — no snack ingredients.',
    '6. Selected snacks deduct their own inventory based on the snack variant chosen for each Mix & Max slot.',
    '7. Do not import this data until the TypeScript validator (pnpm run validate:inventory-setup) returns PASS.',
    '8. Tissue and Fork are optional inventory items — confirm whether they should be tracked before filling them in.',
    '',
    'Required User Decisions:',
    '- Branch names for every row',
    '- Stock units for every inventory item',
    '- Costs (cost_per_unit) for every inventory item',
    '- Reorder levels for every inventory item',
    '- Serving quantities for every product/variant',
    '- Oil allocation per fries size',
    '- Seasoning quantities for every flavor and size (all 48 Flavor BOM rows)',
    '- Packaging quantities per variant',
    '- Mix & Max snack variant mappings (all 21 Mix Max Options rows)',
    '- Opening stock quantities, unit costs, branches, and effective dates',
    '- Whether Tissue and Fork should be tracked as inventory at all',
    '',
    'The workbook formulas on the Validation Summary sheet are only a completion guide.',
    'The TypeScript inventory validator (apps/api/scripts/validate-inventory-setup.ts) remains the final source of truth.',
  ];
  for (const line of lines) {
    const row = sheet.addRow([line]);
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    if (line.endsWith(':')) row.getCell(1).font = { bold: true };
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return sheet;
}

function buildValidationSummarySheet(
  workbook: ExcelJS.Workbook,
  sheetRowCounts: Record<keyof typeof FILES, number>,
  requiredColumnLetters: Record<keyof typeof FILES, string[]>,
) {
  const sheet = workbook.addWorksheet('Validation Summary');
  sheet.getColumn(1).width = 60;
  for (let c = 2; c <= 5; c += 1) sheet.getColumn(c).width = 20;

  const statusRow = sheet.addRow(['Workbook Status: INCOMPLETE']);
  statusRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FFB00020' } };
  const noteRow = sheet.addRow([
    'The workbook formulas are only a completion guide. The TypeScript inventory validator remains the final source of truth.',
  ]);
  noteRow.getCell(1).font = { italic: true };
  noteRow.getCell(1).alignment = { wrapText: true };
  sheet.mergeCells(2, 1, 2, 5);
  sheet.addRow([]);

  const header = ['Sheet', 'Template Rows', 'Required Input Columns', 'Blank Required Cells', 'Status'];
  const headerRow = sheet.addRow(header);
  const headerRowNumber = headerRow.number;
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = THIN_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: 5 } };

  const dataStartRow = headerRowNumber + 1;
  const keys: (keyof typeof FILES)[] = ['ingredients', 'productBom', 'flavorBom', 'mixMax', 'openingStock'];
  const rowNumbers: number[] = [];

  keys.forEach((key, i) => {
    const rowCount = sheetRowCounts[key];
    const sheetTitle = SHEET_TITLES[key];
    const dataRange = (col: string) => `'${sheetTitle}'!${col}2:${col}${rowCount + 1}`;
    const blankFormula = requiredColumnLetters[key].map((col) => `COUNTBLANK(${dataRange(col)})`).join('+') || '0';

    const rowNumber = dataStartRow + i;
    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = sheetTitle;
    row.getCell(2).value = { formula: `COUNTA('${sheetTitle}'!A2:A${rowCount + 1})`, result: rowCount };
    row.getCell(3).value = requiredColumnLetters[key].length;
    row.getCell(4).value = { formula: blankFormula, result: undefined };
    row.getCell(5).value = { formula: `IF(D${rowNumber}=0,"COMPLETE","INCOMPLETE")`, result: undefined };
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    rowNumbers.push(rowNumber);
  });

  const totalRowNumber = dataStartRow + keys.length;
  const totalRow = sheet.getRow(totalRowNumber);
  totalRow.getCell(1).value = 'TOTAL';
  totalRow.getCell(1).font = { bold: true };
  totalRow.getCell(2).value = { formula: `SUM(B${dataStartRow}:B${totalRowNumber - 1})`, result: undefined };
  totalRow.getCell(3).value = { formula: `SUM(C${dataStartRow}:C${totalRowNumber - 1})`, result: undefined };
  totalRow.getCell(4).value = { formula: `SUM(D${dataStartRow}:D${totalRowNumber - 1})`, result: undefined };
  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = THIN_BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  return sheet;
}

export interface GenerationResult {
  outputPath: string;
  rowCounts: Record<keyof typeof FILES, number>;
}

export async function generateWorkbook(baseDir: string = DEFAULT_SETUP_DIR, outputPath: string = DEFAULT_OUTPUT_PATH): Promise<GenerationResult> {
  const csvs: Record<keyof typeof FILES, LoadedCsv> = {
    ingredients: loadCsv(baseDir, 'ingredients'),
    productBom: loadCsv(baseDir, 'productBom'),
    flavorBom: loadCsv(baseDir, 'flavorBom'),
    mixMax: loadCsv(baseDir, 'mixMax'),
    openingStock: loadCsv(baseDir, 'openingStock'),
  };

  const rowCounts: Record<keyof typeof FILES, number> = {
    ingredients: csvs.ingredients.rows.length,
    productBom: csvs.productBom.rows.length,
    flavorBom: csvs.flavorBom.rows.length,
    mixMax: csvs.mixMax.rows.length,
    openingStock: csvs.openingStock.rows.length,
  };

  for (const [key, expected] of Object.entries(EXPECTED_ROW_COUNTS) as [keyof typeof FILES, number][]) {
    if (rowCounts[key] !== expected) {
      throw new Error(`${FILES[key]} has ${rowCounts[key]} data rows, expected ${expected}.`);
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Potato Corner Inventory Setup';
  workbook.created = new Date();

  buildInstructionsSheet(workbook);
  buildIngredientsSheet(workbook, csvs.ingredients);
  buildProductBomSheet(workbook, csvs.productBom);
  buildFlavorBomSheet(workbook, csvs.flavorBom);
  buildMixMaxSheet(workbook, csvs.mixMax);
  buildOpeningStockSheet(workbook, csvs.openingStock);

  const requiredColumnLetters: Record<keyof typeof FILES, string[]> = {
    ingredients: REQUIRED_INPUT_COLUMNS.ingredients.map((name) => columnLetter(csvs.ingredients.headers.indexOf(name))),
    productBom: REQUIRED_INPUT_COLUMNS.productBom.map((name) => columnLetter(csvs.productBom.headers.indexOf(name))),
    flavorBom: REQUIRED_INPUT_COLUMNS.flavorBom.map((name) => columnLetter(csvs.flavorBom.headers.indexOf(name))),
    mixMax: REQUIRED_INPUT_COLUMNS.mixMax.map((name) => columnLetter(csvs.mixMax.headers.indexOf(name))),
    openingStock: REQUIRED_INPUT_COLUMNS.openingStock.map((name) => columnLetter(csvs.openingStock.headers.indexOf(name))),
  };
  buildValidationSummarySheet(workbook, rowCounts, requiredColumnLetters);

  for (const sheet of workbook.worksheets) {
    if (sheet.name === 'Instructions' || sheet.name === 'Validation Summary') {
      sheet.eachRow((row) => row.eachCell((cell) => (cell.protection = { locked: true })));
    }
    await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false });
  }

  const resolvedOutput = path.resolve(outputPath);
  const resolvedSetupDir = path.resolve(DEFAULT_SETUP_DIR);
  if (path.resolve(baseDir) === resolvedSetupDir && path.dirname(resolvedOutput) !== resolvedSetupDir) {
    throw new Error(`Refusing to write outside docs/inventory-setup: ${resolvedOutput}`);
  }
  if (!resolvedOutput.endsWith('.xlsx')) {
    throw new Error('Output path must be an .xlsx file.');
  }

  await workbook.xlsx.writeFile(resolvedOutput);
  return { outputPath: resolvedOutput, rowCounts };
}

const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  generateWorkbook()
    .then((result) => {
      console.log('='.repeat(70));
      console.log('MASTER BOM WORKBOOK GENERATED (workbook generation only — no data imported)');
      console.log('='.repeat(70));
      console.log(`Output: ${result.outputPath}`);
      console.log('Row counts:');
      for (const [key, count] of Object.entries(result.rowCounts)) {
        console.log(`  ${FILES[key as keyof typeof FILES]}: ${count}`);
      }
    })
    .catch((err) => {
      console.error('Failed to generate workbook:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
