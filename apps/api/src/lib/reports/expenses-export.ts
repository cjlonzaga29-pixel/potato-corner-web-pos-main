// apps/api/src/lib/reports/expenses-export.ts
//
// Expenses has no ReportSnapshot-backed data source and, before this fix,
// no registered report_type on POST /reports/export at all — see
// reports.service.ts's EXPENSES branch and the removed "PDF export is not
// available for Expenses" toast in the Admin Reports page. Its rows come
// from expensesRepository.findAll, the exact same query that already backs
// the Expenses tab's on-screen table and its working client-side CSV
// export, so PDF can never show different rows/totals than either of
// those. Kept as its own builder rather than routed through the generic
// generatePdf() (pdf.ts) because Expenses needs a Total Expenses / Total
// Amount summary block that no other report renders — same rationale as
// inventory-summary-export.ts's dedicated builder.
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReportColumn, ReportFilters } from '../../modules/reports/reports.types.js';
import { computeColumnLayout, formatCellValue } from './pdf.js';
import { manilaDateKey } from '../manila-time.js';

const e = React.createElement;

export interface ExpensesExportRow extends Record<string, unknown> {
  incurred_at: string;
  branch: string;
  category: string;
  vendor_name: string;
  amount: string;
  created_by_name: string;
}

export const EXPENSES_EXPORT_COLUMNS: ReportColumn<ExpensesExportRow>[] = [
  { key: 'incurred_at', header: 'Date' },
  { key: 'branch', header: 'Branch' },
  { key: 'category', header: 'Category' },
  { key: 'vendor_name', header: 'Vendor' },
  { key: 'amount', header: 'Amount' },
  { key: 'created_by_name', header: 'Recorded By' },
];

/**
 * react-pdf's built-in Helvetica only covers WinAnsiEncoding, which has no
 * peso sign glyph — every existing report in this app already avoids
 * currency symbols in PDF output for the same reason (pdf.ts and
 * inventory-summary-export.ts both render amounts as plain numbers). "PHP"
 * reads unambiguously without registering a custom Unicode font.
 */
export function formatPhp(amount: number): string {
  return `PHP ${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const styles = StyleSheet.create({
  page: { padding: 24, fontFamily: 'Helvetica' },
  header: { marginBottom: 12 },
  brand: { fontSize: 14, fontWeight: 700 },
  title: { fontSize: 11, marginTop: 2 },
  meta: { fontSize: 8, color: '#444444', marginTop: 2 },
  summary: { marginTop: 8, marginBottom: 8 },
  summaryLine: { fontSize: 9, fontWeight: 700 },
  emptyState: { fontSize: 9, marginTop: 16 },
  table: { display: 'flex', width: '100%', borderTop: '1px solid #000000' },
  row: { flexDirection: 'row', borderBottom: '1px solid #cccccc' },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  cell: { padding: 4, lineHeight: 1.35 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

export async function generateExpensesPdf(
  filters: ReportFilters,
  rows: ExpensesExportRow[],
  totalCount: number,
  totalAmount: number,
  branchName: string | null,
  brandName: string,
): Promise<Buffer> {
  const generatedAt = new Date().toISOString();
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom ? manilaDateKey(filters.dateFrom) : '...'} to ${filters.dateTo ? manilaDateKey(filters.dateTo) : '...'}`
      : 'All dates';

  // Same content-driven, overlap-safe column sizing every other report's
  // PDF uses (pdf.ts's computeColumnLayout) — 6 columns stays under the
  // portrait threshold pdf.ts's generatePdf uses (>6 -> landscape).
  const orientation: 'portrait' | 'landscape' = EXPENSES_EXPORT_COLUMNS.length > 6 ? 'landscape' : 'portrait';
  const { fontSize: bodyFontSize, widths: columnWidths } = computeColumnLayout(EXPENSES_EXPORT_COLUMNS, rows, orientation);

  const headerCells = EXPENSES_EXPORT_COLUMNS.map((c, i) =>
    e(Text, { key: String(c.key), style: [styles.cell, { width: columnWidths[i] }] }, c.header),
  );
  const bodyRows = rows.map((row, i) =>
    e(
      View,
      { key: i, style: styles.row, wrap: false },
      ...EXPENSES_EXPORT_COLUMNS.map((c, ci) =>
        e(Text, { key: String(c.key), style: [styles.cell, { width: columnWidths[ci] }] }, formatCellValue(row[c.key])),
      ),
    ),
  );

  const doc = e(
    Document,
    null,
    e(
      Page,
      { size: 'A4', style: [styles.page, { fontSize: bodyFontSize }], orientation },
      e(
        View,
        { style: styles.header },
        e(Text, { style: styles.brand }, brandName),
        e(Text, { style: styles.title }, 'Expenses Report'),
        e(Text, { style: styles.meta }, `Branch: ${branchName ?? 'All Branches'} | Date range: ${dateRangeLabel} | Generated: ${generatedAt}`),
      ),
      e(
        View,
        { style: styles.summary },
        e(Text, { style: styles.summaryLine }, `Total Expenses: ${totalCount}`),
        e(Text, { style: styles.summaryLine }, `Total Amount: ${formatPhp(totalAmount)}`),
      ),
      rows.length > 0
        ? e(View, { style: styles.table }, e(View, { style: styles.headerRow, fixed: true }, ...headerCells), ...bodyRows)
        : e(Text, { style: styles.emptyState }, 'No expense records found for the selected period.'),
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
