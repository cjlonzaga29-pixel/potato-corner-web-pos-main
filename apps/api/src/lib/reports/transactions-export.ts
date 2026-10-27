// apps/api/src/lib/reports/transactions-export.ts
//
// POS-PERF-P40 — "Download Transaction PDF" from the Reports transaction
// panel. Its own builder (like expenses-export.ts) because the header must
// state the export scope — the whole filtered set or one transaction — which
// no generic report renders. Rows are produced by transactionsService from
// the same where-clause the panel lists with, never from the visible page.
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReportColumn } from '../../modules/reports/reports.types.js';
import { computeColumnLayout, formatCellValue } from './pdf.js';
import { formatManilaDateTime } from '../manila-time.js';

const e = React.createElement;

export interface TransactionExportRow extends Record<string, unknown> {
  created_at: string;
  branch: string;
  receipt_number: string;
  cashier: string;
  payment: string;
  reference: string;
  subtotal: string;
  vat: string;
  discount: string;
  discount_type: string;
  customer_id: string;
  total: string;
  status: string;
}

export const TRANSACTION_EXPORT_COLUMNS: ReportColumn<TransactionExportRow>[] = [
  { key: 'created_at', header: 'Date/Time' },
  { key: 'branch', header: 'Branch' },
  { key: 'receipt_number', header: 'Receipt No.' },
  { key: 'cashier', header: 'Cashier' },
  { key: 'payment', header: 'Payment' },
  { key: 'reference', header: 'Reference' },
  { key: 'subtotal', header: 'Subtotal' },
  { key: 'vat', header: 'VAT' },
  { key: 'discount', header: 'Discount' },
  { key: 'discount_type', header: 'Discount Type' },
  { key: 'customer_id', header: 'Customer ID' },
  { key: 'total', header: 'Total' },
  { key: 'status', header: 'Status' },
];

export interface TransactionExportScope {
  kind: 'filtered' | 'single';
  /** Human-readable filter lines, e.g. "Branch: Manila", "Date: 2026-10-27 to 2026-10-27". */
  filterLines: string[];
  totalCount: number;
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingBottom: 36, fontFamily: 'Helvetica' },
  header: { marginBottom: 10 },
  brand: { fontSize: 14, fontWeight: 700 },
  title: { fontSize: 11, marginTop: 2 },
  meta: { fontSize: 8, color: '#444444', marginTop: 2 },
  scope: { fontSize: 9, fontWeight: 700, marginTop: 6 },
  emptyState: { fontSize: 9, marginTop: 16 },
  table: { display: 'flex', width: '100%', borderTop: '1px solid #000000' },
  row: { flexDirection: 'row', borderBottom: '1px solid #cccccc' },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700, backgroundColor: '#f2f2f2' },
  cell: { padding: 4, lineHeight: 1.35 },
  footer: { position: 'absolute', bottom: 14, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

/** Safe download filename: only [A-Za-z0-9-_], never user-supplied path characters. */
export function buildTransactionExportFilename(scope: 'filtered' | 'single', label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `transactions-${scope}-${safe || 'export'}.pdf`;
}

export async function generateTransactionsPdf(rows: TransactionExportRow[], scope: TransactionExportScope, brandName: string): Promise<Buffer> {
  const generatedAt = formatManilaDateTime(new Date());
  const { fontSize: layoutFontSize, widths: columnWidths } = computeColumnLayout(TRANSACTION_EXPORT_COLUMNS, rows, 'landscape');
  // Widths are sized for layoutFontSize; rendering one point smaller leaves
  // slack for the estimator's rounding, so words like "Completed" and
  // "Payment" are never hyphenated across two lines (seen when visually
  // checking the first render: every row doubled in height).
  const bodyFontSize = Math.max(6, layoutFontSize - 1);

  // fixed: true repeats the header row at the top of every page the table spans.
  const headerCells = TRANSACTION_EXPORT_COLUMNS.map((c, i) =>
    e(Text, { key: String(c.key), style: [styles.cell, { width: columnWidths[i] }] }, c.header),
  );
  const bodyRows = rows.map((row, i) =>
    e(
      View,
      { key: i, style: styles.row, wrap: false },
      ...TRANSACTION_EXPORT_COLUMNS.map((c, ci) =>
        e(Text, { key: String(c.key), style: [styles.cell, { width: columnWidths[ci] }] }, formatCellValue(row[c.key])),
      ),
    ),
  );

  const scopeLine =
    scope.kind === 'single'
      ? 'Scope: one transaction'
      : `Scope: all ${scope.totalCount} transaction(s) matching the filters below (every page, not only the page on screen)`;

  const doc = e(
    Document,
    null,
    e(
      Page,
      { size: 'A4', style: [styles.page, { fontSize: bodyFontSize }], orientation: 'landscape' },
      e(
        View,
        { style: styles.header },
        e(Text, { style: styles.brand }, brandName),
        e(Text, { style: styles.title }, 'Transactions'),
        e(Text, { style: styles.scope }, scopeLine),
        ...scope.filterLines.map((line, i) => e(Text, { key: `f${i}`, style: styles.meta }, line)),
        e(Text, { style: styles.meta }, `Generated: ${generatedAt} (Asia/Manila). Amounts in PHP. "—" means the value was not recorded.`),
      ),
      rows.length > 0
        ? e(View, { style: styles.table }, e(View, { style: styles.headerRow, fixed: true }, ...headerCells), ...bodyRows)
        : e(Text, { style: styles.emptyState }, 'No transactions match these filters.'),
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
