// apps/api/src/lib/reports/csv.ts
import type { ReportColumn } from '../../modules/reports/reports.types.js';

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@']);

function escapeCsvField(value: unknown): string {
  const isString = typeof value === 'string';
  let str = value === null || value === undefined ? '' : String(value);

  // CSV/formula injection: a free-text field (void reason, review notes, etc.)
  // that opens with =, +, -, or @ is interpreted as a formula by
  // Excel/Sheets. Only string-typed values are neutralized — a genuine
  // negative number (e.g. cash variance) is never attacker-controlled text,
  // so it's left as a real number rather than quoted into a text cell.
  if (isString && str.length > 0 && FORMULA_TRIGGER_CHARS.has(str.charAt(0))) {
    str = `'${str}`;
  }

  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Peso amounts are written as plain numbers (no currency symbol) for
 * spreadsheet compatibility — formatting is the viewer's job, not ours.
 */
export function generateCsv<T extends Record<string, unknown>>(data: T[], columns: Array<ReportColumn<T>>): Buffer {
  const visibleColumns = columns.filter((c) => !c.isAudit);
  const auditColumns = columns.filter((c) => c.isAudit);
  const orderedColumns = [...visibleColumns, ...auditColumns];

  const headerRow = [...visibleColumns.map((c) => c.header), ...auditColumns.map((c) => `_${c.header}`)].join(',');
  const dataRows = data.map((row) => orderedColumns.map((c) => escapeCsvField(row[c.key])).join(','));

  return Buffer.from([headerRow, ...dataRows].join('\n'), 'utf-8');
}
