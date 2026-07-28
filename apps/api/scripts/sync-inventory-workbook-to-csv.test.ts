import ExcelJS from 'exceljs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidationReport } from './validate-inventory-setup';
import {
  checkWorkbook,
  csvEscapeField,
  formatDateYMD,
  previewWorkbook,
  serializeCsvRow,
  writeWorkbook,
} from './sync-inventory-workbook-to-csv';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sync-inventory-workbook-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSourceCsvs(dir: string) {
  writeFileSync(path.join(dir, 'ingredients-template.csv'), 'branch_name,inventory_item_name,item_type,stock_unit,cost_per_unit,reorder_level,notes\n');
  writeFileSync(
    path.join(dir, 'product-bom-template.csv'),
    'branch_name,product_name,variant_name,inventory_item_name,mapping_type,quantity_required,unit,required_from_user,notes\n',
  );
  writeFileSync(
    path.join(dir, 'flavor-bom-template.csv'),
    'branch_name,product_name,variant_name,flavor_name,inventory_item_name,quantity_required,unit,required_from_user,notes\n',
  );
  writeFileSync(
    path.join(dir, 'mix-max-snack-options-template.csv'),
    'mix_variant,slot_index,slot_label,allowed_snack_product,allowed_snack_variant,required,notes\n',
  );
  writeFileSync(path.join(dir, 'opening-stock-template.csv'), 'branch_name,inventory_item_name,opening_quantity,unit,unit_cost,effective_date,notes\n');
}

interface BuildOptions {
  omitSheets?: string[];
  duplicateIngredientsHeader?: boolean;
  productBomRowCount?: number;
  blankIngredientCostOnRow2?: boolean;
  formulaOnFlavorBomRow2?: boolean;
}

async function buildWorkbook(opts: BuildOptions = {}): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const include = (name: string) => !opts.omitSheets?.includes(name);

  if (include('Instructions')) wb.addWorksheet('Instructions').addRow(['Instructions']);

  if (include('Ingredients')) {
    const sheet = wb.addWorksheet('Ingredients');
    const headers = ['branch_name', 'inventory_item_name', 'item_type', 'stock_unit', 'cost_per_unit', 'reorder_level', 'notes'];
    if (opts.duplicateIngredientsHeader) headers[6] = 'stock_unit';
    sheet.addRow(headers);
    for (let i = 0; i < 31; i += 1) {
      sheet.addRow(['Main Branch', `Item ${i + 1}`, 'RAW_MATERIAL', 'g', 5, 10, '']);
    }
    if (opts.blankIngredientCostOnRow2) sheet.getRow(2).getCell(5).value = null;
  }

  if (include('Product BOM')) {
    const sheet = wb.addWorksheet('Product BOM');
    sheet.addRow(['branch_name', 'product_name', 'variant_name', 'inventory_item_name', 'mapping_type', 'quantity_required', 'unit', 'required_from_user', 'notes']);
    const count = opts.productBomRowCount ?? 33;
    for (let i = 0; i < count; i += 1) {
      sheet.addRow(['Main Branch', 'Flavored Fries', 'Regular', `Item ${i + 1}`, 'BASE', 10, 'g', 'NO', '']);
    }
  }

  if (include('Flavor BOM')) {
    const sheet = wb.addWorksheet('Flavor BOM');
    sheet.addRow(['branch_name', 'product_name', 'variant_name', 'flavor_name', 'inventory_item_name', 'quantity_required', 'unit', 'required_from_user', 'notes']);
    for (let i = 0; i < 48; i += 1) {
      sheet.addRow(['Main Branch', 'Flavored Fries', 'Regular', 'Cheese', `Seasoning ${i + 1}`, 5, 'g', 'NO', '']);
    }
    if (opts.formulaOnFlavorBomRow2) {
      sheet.getRow(2).getCell(6).value = { formula: '2+3', result: 5 } as ExcelJS.CellFormulaValue;
    }
  }

  if (include('Mix Max Options')) {
    const sheet = wb.addWorksheet('Mix Max Options');
    sheet.addRow(['mix_variant', 'slot_index', 'slot_label', 'allowed_snack_product', 'allowed_snack_variant', 'required', 'notes']);
    for (let i = 0; i < 21; i += 1) {
      sheet.addRow(['Large Mix', 1, `Slot ${i + 1}`, 'Flavored Fries', 'Regular', i % 2 === 0, '']);
    }
  }

  if (include('Opening Stock')) {
    const sheet = wb.addWorksheet('Opening Stock');
    sheet.addRow(['branch_name', 'inventory_item_name', 'opening_quantity', 'unit', 'unit_cost', 'effective_date', 'notes']);
    for (let i = 0; i < 31; i += 1) {
      sheet.addRow(['Main Branch', `Item ${i + 1}`, 100, 'g', 5, new Date(Date.UTC(2026, 0, 15)), '']);
    }
  }

  if (include('Validation Summary')) wb.addWorksheet('Validation Summary').addRow(['Workbook Status: COMPLETE']);

  return wb;
}

async function writeWorkbookFile(wb: ExcelJS.Workbook, dir: string, name = 'potato-corner-master-bom.xlsx'): Promise<string> {
  const p = path.join(dir, name);
  await wb.xlsx.writeFile(p);
  return p;
}

const passingValidation: ValidationReport = {
  result: 'PASS',
  errors: [],
  warnings: [],
  missingCoverage: [],
  duplicateRecords: [],
  unitMismatches: [],
  summary: { branches: 1, inventoryItems: 31, productBomMappings: 33, flavorMappings: 48, mixMaxSnackOptions: 21, openingStockRows: 31 },
};

const failingValidation: ValidationReport = { ...passingValidation, result: 'FAIL', errors: [{ file: 'x', message: 'forced failure' }] };

describe('checkWorkbook', () => {
  it('succeeds for a structurally valid completed fixture', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('PASS');
    expect(report.errors).toEqual([]);
  });

  it('fails clearly when the workbook is missing', async () => {
    writeSourceCsvs(tmpDir);
    const workbookPath = path.join(tmpDir, 'does-not-exist.xlsx');

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.message.includes('Workbook not found'))).toBe(true);
  });

  it('fails clearly when a worksheet is missing', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ omitSheets: ['Opening Stock'] });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.message.includes('Missing worksheet "Opening Stock"'))).toBe(true);
  });

  it('fails clearly on duplicate headers', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ duplicateIngredientsHeader: true });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.message.includes('Duplicate header column "stock_unit"'))).toBe(true);
  });

  it('fails clearly on a row-count mismatch', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ productBomRowCount: 10 });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.message.includes('has 10 data rows, expected 33'))).toBe(true);
  });

  it('reports formula cells where literal values are expected', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ formulaOnFlavorBomRow2: true });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.message.includes('contains a formula'))).toBe(true);
  });

  it('reports blank required cells', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ blankIngredientCostOnRow2: true });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await checkWorkbook({ workbookPath, baseDir: tmpDir });

    expect(report.result).toBe('FAIL');
    expect(report.errors.some((e) => e.message === 'cost_per_unit is required and blank.')).toBe(true);
  });
});

describe('previewWorkbook', () => {
  it('writes CSV files only into the preview directory and reports blank required cells', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ blankIngredientCostOnRow2: true });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const previewDir = path.join(tmpDir, 'preview');

    const before = readdirSync(tmpDir).sort();
    const report = await previewWorkbook({ workbookPath, baseDir: tmpDir, previewDir }, { runValidation: () => failingValidation });
    const after = readdirSync(tmpDir).sort();

    expect(report.result).toBe('FAIL');
    expect(readdirSync(previewDir).sort()).toEqual(
      ['flavor-bom-template.csv', 'ingredients-template.csv', 'mix-max-snack-options-template.csv', 'opening-stock-template.csv', 'product-bom-template.csv'].sort(),
    );
    expect(after).toEqual([...before, 'preview'].sort());
  });

  it('does not modify the source CSV templates', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const before = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');

    await previewWorkbook({ workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview') }, { runValidation: () => passingValidation });

    const after = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');
    expect(after).toBe(before);
  });

  it('exports dates as YYYY-MM-DD', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const previewDir = path.join(tmpDir, 'preview');

    await previewWorkbook({ workbookPath, baseDir: tmpDir, previewDir }, { runValidation: () => passingValidation });

    const csv = readFileSync(path.join(previewDir, 'opening-stock-template.csv'), 'utf8');
    const secondLine = csv.split('\n')[1];
    expect(secondLine).toContain('2026-01-15');
  });

  it('exports booleans as TRUE/FALSE', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const previewDir = path.join(tmpDir, 'preview');

    await previewWorkbook({ workbookPath, baseDir: tmpDir, previewDir }, { runValidation: () => passingValidation });

    const csv = readFileSync(path.join(previewDir, 'mix-max-snack-options-template.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines[1]).toContain(',TRUE,');
    expect(lines[2]).toContain(',FALSE,');
  });
});

describe('CSV escaping', () => {
  it('quotes fields containing commas and doubles embedded quotes', () => {
    expect(csvEscapeField('has,comma')).toBe('"has,comma"');
    expect(csvEscapeField('has "quotes"')).toBe('"has ""quotes"""');
    expect(csvEscapeField('plain')).toBe('plain');
  });

  it('serializes a full row with mixed escaping needs', () => {
    expect(serializeCsvRow(['a', 'b,c', 'd"e'])).toBe('a,"b,c","d""e"');
  });

  it('formats dates as YYYY-MM-DD', () => {
    expect(formatDateYMD(new Date(Date.UTC(2026, 6, 4)))).toBe('2026-07-04');
  });
});

describe('writeWorkbook', () => {
  it('is blocked when required cells are blank', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook({ blankIngredientCostOnRow2: true });
    const workbookPath = await writeWorkbookFile(wb, tmpDir);

    const report = await writeWorkbook(
      { workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview'), backupRoot: path.join(tmpDir, 'backups') },
      { runValidation: () => passingValidation },
    );

    expect(report.status).toBe('BLOCKED');
    expect(existsSync(path.join(tmpDir, 'backups'))).toBe(false);
  });

  it('creates timestamped backups before writing', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const backupRoot = path.join(tmpDir, 'backups');
    const originalIngredients = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');

    const report = await writeWorkbook(
      { workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview'), backupRoot },
      { runValidation: () => passingValidation },
    );

    expect(report.status).toBe('SUCCESS');
    expect(report.backupDir).toBeDefined();
    const backedUp = readFileSync(path.join(report.backupDir!, 'ingredients-template.csv'), 'utf8');
    expect(backedUp).toBe(originalIngredients);
  });

  it('restores backups when post-write validation fails', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const backupRoot = path.join(tmpDir, 'backups');
    const originalIngredients = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');

    let calls = 0;
    const report = await writeWorkbook(
      { workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview'), backupRoot },
      {
        runValidation: () => {
          calls += 1;
          return calls === 1 ? passingValidation : failingValidation;
        },
      },
    );

    expect(report.status).toBe('FAILED_RESTORED');
    const restored = readFileSync(path.join(tmpDir, 'ingredients-template.csv'), 'utf8');
    expect(restored).toBe(originalIngredients);
  });
});

describe('safety', () => {
  it('never modifies the source workbook file', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const before = readFileSync(workbookPath);

    await checkWorkbook({ workbookPath, baseDir: tmpDir });
    await previewWorkbook({ workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview') }, { runValidation: () => passingValidation });
    await writeWorkbook(
      { workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview'), backupRoot: path.join(tmpDir, 'backups') },
      { runValidation: () => passingValidation },
    );

    const after = readFileSync(workbookPath);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it('does not write files outside the base directory', async () => {
    const outerDir = mkdtempSync(path.join(os.tmpdir(), 'sync-inventory-outer-'));
    try {
      writeSourceCsvs(tmpDir);
      const wb = await buildWorkbook();
      const workbookPath = await writeWorkbookFile(wb, tmpDir);
      const outerBefore = readdirSync(outerDir);

      await writeWorkbook(
        { workbookPath, baseDir: tmpDir, previewDir: path.join(tmpDir, 'preview'), backupRoot: path.join(tmpDir, 'backups') },
        { runValidation: () => passingValidation },
      );

      expect(readdirSync(outerDir)).toEqual(outerBefore);
    } finally {
      rmSync(outerDir, { recursive: true, force: true });
    }
  });

  it('rejects a preview directory outside the base directory', async () => {
    writeSourceCsvs(tmpDir);
    const wb = await buildWorkbook();
    const workbookPath = await writeWorkbookFile(wb, tmpDir);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'sync-inventory-outside-'));

    try {
      await expect(previewWorkbook({ workbookPath, baseDir: tmpDir, previewDir: outsideDir })).rejects.toThrow(/outside/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
