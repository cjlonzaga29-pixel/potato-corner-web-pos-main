// Reads docs/inventory-setup/potato-corner-master-bom.xlsx and prepares
// updated CSV files for validation. Tooling only: no Prisma/database
// client, no network requests, no migrations, no import logic. Never
// writes the .xlsx workbook or README.md, and only reads/writes inside
// docs/inventory-setup/.
import ExcelJS from 'exceljs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETUP_DIR, FILES, runValidation, type ValidationReport } from './validate-inventory-setup';

export const DEFAULT_WORKBOOK_PATH = path.resolve(DEFAULT_SETUP_DIR, 'potato-corner-master-bom.xlsx');
export const DEFAULT_PREVIEW_DIR = path.resolve(DEFAULT_SETUP_DIR, 'preview');
export const DEFAULT_BACKUP_ROOT = path.resolve(DEFAULT_SETUP_DIR, 'backups');

const SHEET_TITLES: Record<keyof typeof FILES, string> = {
  ingredients: 'Ingredients',
  productBom: 'Product BOM',
  flavorBom: 'Flavor BOM',
  mixMax: 'Mix Max Options',
  openingStock: 'Opening Stock',
};

const DATA_KEYS = Object.keys(SHEET_TITLES) as (keyof typeof FILES)[];
const ALL_SHEET_NAMES = ['Instructions', ...DATA_KEYS.map((k) => SHEET_TITLES[k]), 'Validation Summary'];

// Mirrored from generate-inventory-workbook.ts — the workbook is generated
// from CSVs with exactly these row counts, so a completed workbook must
// still carry them.
const EXPECTED_ROW_COUNTS: Record<keyof typeof FILES, number> = {
  ingredients: 31,
  productBom: 33,
  flavorBom: 48,
  mixMax: 21,
  openingStock: 31,
};

const BOOLEAN_COLUMNS: Partial<Record<keyof typeof FILES, string[]>> = { mixMax: ['required'] };

// Fields whose blank value must be reported per the workbook specification.
// branch_name is only checked for sheets whose source CSV actually has it
// (Mix Max Options does not).
const REQUIRED_FIELDS: Record<keyof typeof FILES, string[]> = {
  ingredients: ['branch_name', 'stock_unit', 'cost_per_unit', 'reorder_level'],
  productBom: ['branch_name', 'quantity_required', 'unit', 'required_from_user'],
  flavorBom: ['branch_name', 'quantity_required', 'unit', 'required_from_user'],
  mixMax: ['allowed_snack_variant', 'required'],
  openingStock: ['branch_name', 'opening_quantity', 'unit', 'unit_cost', 'effective_date'],
};

export interface Issue {
  file: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
}

interface ExtractedRow {
  line: number;
  values: Record<string, string>;
}

interface ExtractedSheet {
  headers: string[];
  rows: ExtractedRow[];
  issues: Issue[];
}

export interface CheckReport {
  result: 'PASS' | 'FAIL';
  errors: Issue[];
  warnings: Issue[];
  sheets: Partial<Record<keyof typeof FILES, { headers: string[]; rowCount: number }>>;
}

export interface PreviewFileSummary {
  file: string;
  path: string;
  rowCount: number;
  blankRequiredCount: number;
}

export interface PreviewReport {
  check: CheckReport;
  result: 'PASS' | 'FAIL';
  files: PreviewFileSummary[];
  validation?: ValidationReport;
}

export interface WriteReport {
  status: 'BLOCKED' | 'SUCCESS' | 'FAILED_RESTORED';
  reason?: string;
  backupDir?: string;
  preview: PreviewReport;
}

interface RunValidationFn {
  (baseDir?: string): ValidationReport;
}

interface Deps {
  runValidation?: RunValidationFn;
}

function assertWithin(childPath: string, parentDir: string): void {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child !== parent && !child.startsWith(parent + path.sep)) {
    throw new Error(`Refusing to access path outside ${parent}: ${child}`);
  }
}

export function csvEscapeField(value: string): string {
  if (/["\n\r,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeCsvRow(fields: string[]): string {
  return fields.map(csvEscapeField).join(',');
}

export function formatDateYMD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cellPrimitiveToCsv(v: string | number | boolean, key: keyof typeof FILES, columnName: string): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  const boolCols = BOOLEAN_COLUMNS[key] ?? [];
  if (boolCols.includes(columnName)) {
    const norm = v.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(norm)) return 'TRUE';
    if (['false', 'no', '0'].includes(norm)) return 'FALSE';
  }
  return v;
}

function cellToCsvValue(
  cell: ExcelJS.Cell,
  key: keyof typeof FILES,
  columnName: string,
  fileName: string,
  line: number,
  issues: Issue[],
): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return formatDateYMD(v);
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if ('formula' in obj) {
      issues.push({
        file: fileName,
        line,
        message: `Column "${columnName}" contains a formula; a literal value is expected.`,
        severity: 'error',
      });
      const result = obj.result;
      if (result === null || result === undefined) return '';
      if (result instanceof Date) return formatDateYMD(result);
      if (typeof result === 'object') return '';
      return cellPrimitiveToCsv(result as string | number | boolean, key, columnName);
    }
    if ('richText' in obj) {
      issues.push({
        file: fileName,
        line,
        message: `Column "${columnName}" contains rich text; a plain value is expected.`,
        severity: 'error',
      });
      return (obj.richText as { text: string }[]).map((t) => t.text).join('');
    }
    if ('error' in obj) {
      issues.push({ file: fileName, line, message: `Column "${columnName}" contains an error value "${obj.error}".`, severity: 'error' });
      return '';
    }
    if ('hyperlink' in obj) {
      issues.push({
        file: fileName,
        line,
        message: `Column "${columnName}" contains a hyperlink; a plain value is expected.`,
        severity: 'error',
      });
      return String(obj.text ?? '');
    }
    issues.push({ file: fileName, line, message: `Column "${columnName}" has an unsupported cell type.`, severity: 'error' });
    return String(v);
  }
  return cellPrimitiveToCsv(v as string | number | boolean, key, columnName);
}

function extractDataSheet(sheet: ExcelJS.Worksheet, key: keyof typeof FILES): ExtractedSheet {
  const fileName = FILES[key];
  const issues: Issue[] = [];

  const headerValues = sheet.getRow(1).values as ExcelJS.CellValue[];
  const headers: string[] = [];
  for (let c = 1; c < headerValues.length; c += 1) {
    const v = headerValues[c];
    headers.push(v === null || v === undefined ? '' : String(v).trim());
  }

  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) issues.push({ file: fileName, line: 1, message: `Duplicate header column "${h}".`, severity: 'error' });
    seen.add(h);
  }

  const rows: ExtractedRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const excelRow = sheet.getRow(r);
    const values: Record<string, string> = {};
    let anyValue = false;
    headers.forEach((h, idx) => {
      const cell = excelRow.getCell(idx + 1);
      const csvVal = cellToCsvValue(cell, key, h, fileName, r, issues);
      values[h] = csvVal;
      if (csvVal !== '') anyValue = true;
    });
    if (!anyValue) {
      issues.push({ file: fileName, line: r, message: 'Completely blank row.', severity: 'error' });
      continue;
    }
    rows.push({ line: r, values });
  }

  return { headers, rows, issues };
}

function buildCsvText(ext: ExtractedSheet): string {
  const lines = [serializeCsvRow(ext.headers)];
  for (const row of ext.rows) {
    lines.push(serializeCsvRow(ext.headers.map((h) => row.values[h] ?? '')));
  }
  return lines.join('\n') + '\n';
}

interface CheckOptions {
  workbookPath?: string;
  baseDir?: string;
}

interface InternalCheckResult extends CheckReport {
  extracted: Partial<Record<keyof typeof FILES, ExtractedSheet>>;
}

async function checkWorkbookInternal(opts: CheckOptions = {}): Promise<InternalCheckResult> {
  const workbookPath = opts.workbookPath ?? DEFAULT_WORKBOOK_PATH;
  const baseDir = opts.baseDir ?? DEFAULT_SETUP_DIR;
  assertWithin(workbookPath, baseDir);

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const sheetsInfo: CheckReport['sheets'] = {};
  const extracted: InternalCheckResult['extracted'] = {};

  if (!existsSync(workbookPath)) {
    errors.push({ file: path.basename(workbookPath), message: `Workbook not found: ${workbookPath}`, severity: 'error' });
    return { result: 'FAIL', errors, warnings, sheets: sheetsInfo, extracted };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(workbookPath);
  } catch (err) {
    errors.push({
      file: path.basename(workbookPath),
      message: `Failed to read workbook: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'error',
    });
    return { result: 'FAIL', errors, warnings, sheets: sheetsInfo, extracted };
  }

  const presentNames = workbook.worksheets.map((s) => s.name);
  for (const name of ALL_SHEET_NAMES) {
    if (!presentNames.includes(name)) errors.push({ file: 'workbook', message: `Missing worksheet "${name}".`, severity: 'error' });
  }
  for (const name of presentNames) {
    if (!ALL_SHEET_NAMES.includes(name)) errors.push({ file: 'workbook', message: `Unexpected worksheet "${name}".`, severity: 'error' });
  }

  for (const key of DATA_KEYS) {
    const sheetName = SHEET_TITLES[key];
    const sheet = workbook.getWorksheet(sheetName);
    const fileName = FILES[key];
    if (!sheet) continue;

    const ext = extractDataSheet(sheet, key);
    extracted[key] = ext;
    sheetsInfo[key] = { headers: ext.headers, rowCount: ext.rows.length };
    for (const issue of ext.issues) {
      if (issue.severity === 'error') errors.push(issue);
      else warnings.push(issue);
    }

    const sourcePath = path.join(baseDir, fileName);
    if (existsSync(sourcePath)) {
      const firstLine = readFileSync(sourcePath, 'utf8').split(/\r?\n/, 1)[0] ?? '';
      const expectedHeaders = firstLine.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
      const missingHeaders = expectedHeaders.filter((h) => !ext.headers.includes(h));
      const extraHeaders = ext.headers.filter((h) => !expectedHeaders.includes(h));
      for (const h of missingHeaders) {
        errors.push({ file: fileName, line: 1, message: `Missing expected header "${h}" (present in source template).`, severity: 'error' });
      }
      for (const h of extraHeaders) {
        errors.push({ file: fileName, line: 1, message: `Unexpected header "${h}" not present in source template.`, severity: 'error' });
      }
      if (missingHeaders.length === 0 && extraHeaders.length === 0 && JSON.stringify(expectedHeaders) !== JSON.stringify(ext.headers)) {
        warnings.push({ file: fileName, line: 1, message: 'Header order differs from source template.', severity: 'warning' });
      }
    }

    const expectedCount = EXPECTED_ROW_COUNTS[key];
    if (ext.rows.length !== expectedCount) {
      errors.push({
        file: fileName,
        message: `Sheet "${sheetName}" has ${ext.rows.length} data rows, expected ${expectedCount}.`,
        severity: 'error',
      });
    }

    const seenRows = new Set<string>();
    for (const row of ext.rows) {
      const rowKey = JSON.stringify(ext.headers.map((h) => row.values[h]));
      if (seenRows.has(rowKey)) {
        errors.push({ file: fileName, line: row.line, message: 'Duplicate logical record (identical row).', severity: 'error' });
      } else {
        seenRows.add(rowKey);
      }
    }

    const requiredCols = REQUIRED_FIELDS[key].filter((c) => ext.headers.includes(c));
    for (const row of ext.rows) {
      for (const col of requiredCols) {
        if ((row.values[col] ?? '') === '') {
          errors.push({ file: fileName, line: row.line, message: `${col} is required and blank.`, severity: 'error' });
        }
      }
    }
  }

  return { result: errors.length === 0 ? 'PASS' : 'FAIL', errors, warnings, sheets: sheetsInfo, extracted };
}

export async function checkWorkbook(opts: CheckOptions = {}): Promise<CheckReport> {
  const { extracted: _extracted, ...report } = await checkWorkbookInternal(opts);
  return report;
}

interface PreviewOptions extends CheckOptions {
  previewDir?: string;
}

export async function previewWorkbook(opts: PreviewOptions = {}, deps: Deps = {}): Promise<PreviewReport> {
  const workbookPath = opts.workbookPath ?? DEFAULT_WORKBOOK_PATH;
  const baseDir = opts.baseDir ?? DEFAULT_SETUP_DIR;
  const previewDir = opts.previewDir ?? DEFAULT_PREVIEW_DIR;
  assertWithin(previewDir, baseDir);
  if (path.resolve(previewDir) === path.resolve(baseDir)) {
    throw new Error('previewDir must not equal baseDir');
  }

  const fullCheck = await checkWorkbookInternal({ workbookPath, baseDir });
  const { extracted, ...check } = fullCheck;

  if (existsSync(previewDir)) rmSync(previewDir, { recursive: true, force: true });
  mkdirSync(previewDir, { recursive: true });

  const files: PreviewFileSummary[] = [];
  for (const key of DATA_KEYS) {
    const ext = extracted[key];
    if (!ext) continue;
    const fileName = FILES[key];
    const outPath = path.join(previewDir, fileName);
    assertWithin(outPath, baseDir);
    writeFileSync(outPath, buildCsvText(ext), 'utf8');
    const blankRequiredCount = check.errors.filter((e) => e.file === fileName && e.message.endsWith('is required and blank.')).length;
    files.push({ file: fileName, path: outPath, rowCount: ext.rows.length, blankRequiredCount });
  }

  const runValidationFn = deps.runValidation ?? runValidation;
  let validation: ValidationReport | undefined;
  try {
    validation = runValidationFn(previewDir);
  } catch {
    validation = undefined;
  }

  const result: 'PASS' | 'FAIL' = check.result === 'PASS' && validation?.result === 'PASS' ? 'PASS' : 'FAIL';

  return { check, result, files, validation };
}

interface WriteOptions extends PreviewOptions {
  backupRoot?: string;
}

function restoreBackup(backupDir: string, baseDir: string): void {
  for (const key of DATA_KEYS) {
    const fileName = FILES[key];
    copyFileSync(path.join(backupDir, fileName), path.join(baseDir, fileName));
  }
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function writeWorkbook(opts: WriteOptions = {}, deps: Deps = {}): Promise<WriteReport> {
  const workbookPath = opts.workbookPath ?? DEFAULT_WORKBOOK_PATH;
  const baseDir = opts.baseDir ?? DEFAULT_SETUP_DIR;
  const previewDir = opts.previewDir ?? DEFAULT_PREVIEW_DIR;
  const backupRoot = opts.backupRoot ?? DEFAULT_BACKUP_ROOT;
  assertWithin(previewDir, baseDir);
  assertWithin(backupRoot, baseDir);

  const preview = await previewWorkbook({ workbookPath, baseDir, previewDir }, deps);

  if (preview.check.result !== 'PASS') {
    return { status: 'BLOCKED', reason: 'Workbook structural validation failed.', preview };
  }
  if (!preview.validation || preview.validation.result !== 'PASS') {
    return { status: 'BLOCKED', reason: 'Preview CSVs failed the inventory validator.', preview };
  }

  const missingSource = DATA_KEYS.map((k) => FILES[k]).filter((f) => !existsSync(path.join(baseDir, f)));
  if (missingSource.length > 0) {
    return { status: 'BLOCKED', reason: `Missing source CSV(s): ${missingSource.join(', ')}`, preview };
  }

  const backupDir = path.join(backupRoot, formatTimestamp(new Date()));
  assertWithin(backupDir, baseDir);
  mkdirSync(backupDir, { recursive: true });
  for (const key of DATA_KEYS) {
    const fileName = FILES[key];
    copyFileSync(path.join(baseDir, fileName), path.join(backupDir, fileName));
  }

  try {
    for (const key of DATA_KEYS) {
      const fileName = FILES[key];
      const target = path.join(baseDir, fileName);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, readFileSync(path.join(previewDir, fileName)));
      renameSync(tmp, target);
    }
  } catch (err) {
    restoreBackup(backupDir, baseDir);
    return {
      status: 'FAILED_RESTORED',
      reason: `Write failed and backups were restored: ${err instanceof Error ? err.message : String(err)}`,
      backupDir,
      preview,
    };
  }

  const runValidationFn = deps.runValidation ?? runValidation;
  const postValidation = runValidationFn(baseDir);
  if (postValidation.result !== 'PASS') {
    restoreBackup(backupDir, baseDir);
    return { status: 'FAILED_RESTORED', reason: 'Post-write validation failed; backups were restored.', backupDir, preview };
  }

  return { status: 'SUCCESS', backupDir, preview };
}

function printCheckReport(report: CheckReport) {
  console.log('='.repeat(70));
  console.log('WORKBOOK-TO-CSV SYNC — CHECK (no files written)');
  console.log('='.repeat(70));
  console.log(`Result: ${report.result}`);
  console.log(`Errors: ${report.errors.length}, Warnings: ${report.warnings.length}`);
  for (const [key, info] of Object.entries(report.sheets)) {
    console.log(`  ${SHEET_TITLES[key as keyof typeof FILES]}: ${info?.rowCount} data rows`);
  }
  if (report.errors.length > 0) {
    console.log('\n--- Errors ---');
    for (const e of report.errors) console.log(`  ${e.file} line ${e.line ?? '-'}: ${e.message}`);
  }
  if (report.warnings.length > 0) {
    console.log('\n--- Warnings ---');
    for (const w of report.warnings) console.log(`  ${w.file} line ${w.line ?? '-'}: ${w.message}`);
  }
}

function printPreviewReport(report: PreviewReport) {
  printCheckReport(report.check);
  console.log('\n--- Preview output ---');
  for (const f of report.files) {
    console.log(`  ${f.path} (${f.rowCount} rows, ${f.blankRequiredCount} blank required values)`);
  }
  console.log(`\nValidator result: ${report.validation?.result ?? 'NOT RUN'}`);
  console.log(`Overall preview result: ${report.result}`);
}

function printWriteReport(report: WriteReport) {
  printPreviewReport(report.preview);
  console.log('\n--- Write ---');
  console.log(`Status: ${report.status}`);
  if (report.reason) console.log(`Reason: ${report.reason}`);
  if (report.backupDir) console.log(`Backup: ${report.backupDir}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--check') {
    const report = await checkWorkbook();
    printCheckReport(report);
    process.exit(report.result === 'PASS' ? 0 : 1);
  } else if (mode === '--preview') {
    const report = await previewWorkbook();
    printPreviewReport(report);
    process.exit(report.result === 'PASS' ? 0 : 1);
  } else if (mode === '--write') {
    const report = await writeWorkbook();
    printWriteReport(report);
    process.exit(report.status === 'SUCCESS' ? 0 : 1);
  } else {
    console.error('Usage: sync-inventory-workbook-to-csv.ts --check | --preview | --write');
    process.exit(1);
  }
}

const isMain = path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error('Sync failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
