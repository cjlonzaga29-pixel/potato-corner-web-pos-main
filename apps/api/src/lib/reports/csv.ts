// apps/api/src/lib/reports/csv.ts
import type { ReportColumn } from '../../modules/reports/reports.types.js';

function escapeCsvField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
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
