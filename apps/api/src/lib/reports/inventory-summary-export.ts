// apps/api/src/lib/reports/inventory-summary-export.ts
//
// Task 110: the Inventory Summary report renders as two disjoint sections —
// Ingredient Consumption (KG) and Packaging Consumption (PC) — that must
// never share a table/column set. The generic column-based generateCsv/
// generatePdf (lib/reports/csv.ts, lib/reports/pdf.ts) assume one flat table
// per report, so this report gets its own dedicated builders instead of a
// REPORT_COLUMNS entry.
//
// Task 114: rows needing kg-conversion setup are NOT a third section — they
// stay inside Ingredient Consumption (KG) (section === 'INGREDIENT_KG') with
// status 'CONVERSION_REQUIRED'. Their kg fields are null (rendered as '—')
// and they are excluded from the kg totals row, but the row itself is never
// hidden or moved elsewhere.
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { InventorySummaryReportRow } from '@potato-corner/shared';
import type { ReportFilters } from '../../modules/reports/reports.types.js';
import { escapeCsvField } from './csv.js';
import { manilaDateKey } from '../manila-time.js';

const e = React.createElement;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumBy(rows: InventorySummaryReportRow[], key: keyof InventorySummaryReportRow): number {
  return round2(rows.reduce((total, r) => total + (Number(r[key]) || 0), 0));
}

function splitSections(rows: InventorySummaryReportRow[]) {
  return {
    ingredientRows: rows.filter((r) => r.section === 'INGREDIENT_KG'),
    packagingRows: rows.filter((r) => r.section === 'PACKAGING_PC'),
  };
}

const STATUS_LABEL: Record<'CONVERTED' | 'CONVERSION_REQUIRED', string> = {
  CONVERTED: 'Converted',
  CONVERSION_REQUIRED: 'Conversion required',
};

function statusLabel(r: InventorySummaryReportRow): string {
  return r.status ? STATUS_LABEL[r.status] : '';
}

function csvSectionLines(title: string, headers: string[], dataRows: Array<Array<string | number>>, totalsRow: Array<string | number>): string[] {
  return [title, headers.join(','), ...dataRows.map((row) => row.map(escapeCsvField).join(',')), totalsRow.map(escapeCsvField).join(',')];
}

/** CSV: Section 1 (Ingredient Consumption (KG), including CONVERSION_REQUIRED rows with blank kg fields and a Status column), a blank line, then Section 2 (Packaging Consumption (PC)). Only two sections, ever — never mixes kg and pc columns in one table. */
export function generateInventorySummaryCsv(rows: InventorySummaryReportRow[]): Buffer {
  const { ingredientRows, packagingRows } = splitSections(rows);

  const section1 = csvSectionLines(
    'Ingredient Consumption (KG)',
    ['Ingredient', 'Opening Stock (kg)', 'Consumed Today (kg)', 'Consumed This Month (kg)', 'Remaining (kg)', 'Status'],
    ingredientRows.map((r) => [
      r.ingredient_name,
      r.opening_stock_kg ?? '',
      r.consumed_today_kg ?? '',
      r.consumed_this_month_kg ?? '',
      r.remaining_kg ?? '',
      statusLabel(r),
    ]),
    [
      'Total',
      sumBy(ingredientRows, 'opening_stock_kg'),
      sumBy(ingredientRows, 'consumed_today_kg'),
      sumBy(ingredientRows, 'consumed_this_month_kg'),
      sumBy(ingredientRows, 'remaining_kg'),
      '',
    ],
  );

  // Section 2's footer only totals Consumed Today/Month per spec — Opening
  // and Remaining are left blank in the totals row, not zero-filled.
  const section2 = csvSectionLines(
    'Packaging Consumption (PC)',
    ['Packaging', 'Opening Stock (pc)', 'Consumed Today (pc)', 'Consumed This Month (pc)', 'Remaining (pc)'],
    packagingRows.map((r) => [r.ingredient_name, r.opening_stock, r.consumed_today, r.consumed_this_month, r.remaining_stock]),
    ['Total', '', sumBy(packagingRows, 'consumed_today'), sumBy(packagingRows, 'consumed_this_month'), ''],
  );

  const lines = [...section1, '', ...section2];

  return Buffer.from(lines.join('\n'), 'utf-8');
}

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 9, fontFamily: 'Helvetica' },
  header: { marginBottom: 12 },
  brand: { fontSize: 14, fontWeight: 700 },
  title: { fontSize: 11, marginTop: 2 },
  meta: { fontSize: 8, color: '#444444', marginTop: 2 },
  sectionTitle: { fontSize: 10, fontWeight: 700, marginTop: 16, marginBottom: 6 },
  table: { display: 'flex', width: '100%', borderTop: '1px solid #000000' },
  row: { flexDirection: 'row', borderBottom: '1px solid #cccccc' },
  totalsRow: { flexDirection: 'row', borderBottom: '1px solid #000000', borderTop: '1px solid #000000', fontWeight: 700 },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  cell: { flex: 1, padding: 4 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

function pdfTable(
  headers: string[],
  dataRows: Array<Array<string | number>>,
  totalsRow?: Array<string | number>,
): ReturnType<typeof e> {
  return e(
    View,
    { style: styles.table },
    e(View, { style: styles.headerRow }, ...headers.map((h, i) => e(Text, { key: i, style: styles.cell }, h))),
    ...dataRows.map((row, i) => e(View, { key: i, style: styles.row, wrap: false }, ...row.map((v, j) => e(Text, { key: j, style: styles.cell }, String(v))))),
    ...(totalsRow ? [e(View, { style: styles.totalsRow }, ...totalsRow.map((v, i) => e(Text, { key: i, style: styles.cell }, String(v))))] : []),
  );
}

/** PDF: one document — title header, then Section 1's table (Ingredient Consumption (KG), including CONVERSION_REQUIRED rows with a Status column and blank kg cells), then Section 2's table (Packaging Consumption (PC)). Only two sections, ever. */
export async function generateInventorySummaryPdf(filters: ReportFilters, rows: InventorySummaryReportRow[], branchName: string | null): Promise<Buffer> {
  const { ingredientRows, packagingRows } = splitSections(rows);
  const generatedAt = new Date().toISOString();
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom ? manilaDateKey(filters.dateFrom) : '...'} to ${filters.dateTo ? manilaDateKey(filters.dateTo) : '...'}`
      : 'All dates';

  const ingredientTable = pdfTable(
    ['Ingredient', 'Opening Stock (kg)', 'Consumed Today (kg)', 'Consumed This Month (kg)', 'Remaining (kg)', 'Status'],
    ingredientRows.map((r) => [
      r.ingredient_name,
      r.opening_stock_kg ?? '—',
      r.consumed_today_kg ?? '—',
      r.consumed_this_month_kg ?? '—',
      r.remaining_kg ?? '—',
      statusLabel(r),
    ]),
    [
      'Total',
      sumBy(ingredientRows, 'opening_stock_kg'),
      sumBy(ingredientRows, 'consumed_today_kg'),
      sumBy(ingredientRows, 'consumed_this_month_kg'),
      sumBy(ingredientRows, 'remaining_kg'),
      '',
    ],
  );

  const packagingTable = pdfTable(
    ['Packaging', 'Opening Stock (pc)', 'Consumed Today (pc)', 'Consumed This Month (pc)', 'Remaining (pc)'],
    packagingRows.map((r) => [r.ingredient_name, r.opening_stock, r.consumed_today, r.consumed_this_month, r.remaining_stock]),
    ['Total', '', sumBy(packagingRows, 'consumed_today'), sumBy(packagingRows, 'consumed_this_month'), ''],
  );

  const doc = e(
    Document,
    null,
    e(
      Page,
      { size: 'A4', style: styles.page, orientation: 'landscape' },
      e(
        View,
        { style: styles.header },
        e(Text, { style: styles.brand }, 'POTATO CORNER'),
        e(Text, { style: styles.title }, 'Inventory Summary Report'),
        e(Text, { style: styles.meta }, `Branch: ${branchName ?? 'All Branches'} | Date range: ${dateRangeLabel} | Generated: ${generatedAt}`),
      ),
      e(Text, { style: styles.sectionTitle }, 'Ingredient Consumption (KG)'),
      ingredientTable,
      e(Text, { style: styles.sectionTitle }, 'Packaging Consumption (PC)'),
      packagingTable,
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
