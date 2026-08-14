// apps/api/src/lib/reports/inventory-summary-export.ts
//
// TASK 157: the Inventory Summary report renders as two independently-
// dimensioned tables — Ingredient Weight Consumption (KG), converted from
// each item's native unit, and Packaging Consumption (PC), every
// COUNT-dimension item in its native quantity — rather than one mixed-unit
// table (TASK 144/149). The generic column-based generateCsv/generatePdf
// (lib/reports/csv.ts, lib/reports/pdf.ts) assume one totals row per whole
// report and a single flat row shape, neither of which fits two tables with
// different columns, so this report keeps its own dedicated builders
// instead of a REPORT_COLUMNS entry.
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { IngredientWeightKgRow, PackagingPcRow, IngredientWeightTotalsKg, PackagingTotalsPc } from '@potato-corner/shared';
import type { ReportFilters } from '../../modules/reports/reports.types.js';
import { escapeCsvField } from './csv.js';
import { manilaDateKey } from '../manila-time.js';

const MISSING_CONVERSION_WARNING = 'Some ingredients have no weight conversion configured — shown in native units only, excluded from the KG totals.';

export interface InventorySummarySplit {
  ingredientWeightKg: IngredientWeightKgRow[];
  packagingPc: PackagingPcRow[];
  ingredientWeightTotalsKg: IngredientWeightTotalsKg;
  packagingTotalsPc: PackagingTotalsPc;
  excludedIngredientCount: number;
}

const e = React.createElement;

const KG_HEADERS = [
  'Ingredient',
  'Base Unit',
  'Opening Stock',
  'Consumed Today',
  'Consumed This Month',
  'Remaining',
  'Opening Stock (KG)',
  'Consumed Today (KG)',
  'Consumed This Month (KG)',
  'Remaining (KG)',
  'Status',
];
const PC_HEADERS = ['Packaging', 'Opening Stock (PC)', 'Consumed Today (PC)', 'Consumed This Month (PC)', 'Remaining (PC)'];

const statusLabel = (status: IngredientWeightKgRow['status']) => (status === 'converted' ? 'Converted' : 'Conversion Needed');
const kgCell = (v: number | null) => (v === null ? '—' : v);

/**
 * CSV: exactly two sections — "Ingredient Weight Consumption (KG)" then
 * "Packaging Consumption (PC)", each with its own header row, data rows, and
 * a single Total row, separated by a blank line. Every non-COUNT ingredient
 * gets a row regardless of whether a KG conversion exists — rows without one
 * show '—' in the KG columns and 'Conversion Needed' in Status; the Total
 * row only sums converted rows, so its native-unit columns stay blank
 * (native units differ per row and can't be meaningfully summed).
 */
export function generateInventorySummaryCsv(split: InventorySummarySplit): Buffer {
  const { ingredientWeightKg, packagingPc, ingredientWeightTotalsKg, packagingTotalsPc, excludedIngredientCount } = split;

  const lines = [
    'Ingredient Weight Consumption (KG)',
    KG_HEADERS.join(','),
    ...ingredientWeightKg.map((r) =>
      [
        r.ingredient_name,
        r.unit_code,
        r.opening_stock,
        r.consumed_today,
        r.consumed_this_month,
        r.remaining,
        kgCell(r.opening_stock_kg),
        kgCell(r.consumed_today_kg),
        kgCell(r.consumed_this_month_kg),
        kgCell(r.remaining_kg),
        statusLabel(r.status),
      ]
        .map(escapeCsvField)
        .join(','),
    ),
    [
      'Total',
      '',
      '',
      '',
      '',
      '',
      ingredientWeightTotalsKg.opening_stock_kg,
      ingredientWeightTotalsKg.consumed_today_kg,
      ingredientWeightTotalsKg.consumed_this_month_kg,
      ingredientWeightTotalsKg.remaining_kg,
      '',
    ]
      .map(escapeCsvField)
      .join(','),
    '',
    'Packaging Consumption (PC)',
    PC_HEADERS.join(','),
    ...packagingPc.map((r) =>
      [r.ingredient_name, r.opening_stock_pc, r.consumed_today_pc, r.consumed_this_month_pc, r.remaining_pc].map(escapeCsvField).join(','),
    ),
    [
      'Total',
      packagingTotalsPc.opening_stock_pc,
      packagingTotalsPc.consumed_today_pc,
      packagingTotalsPc.consumed_this_month_pc,
      packagingTotalsPc.remaining_pc,
    ]
      .map(escapeCsvField)
      .join(','),
  ];

  if (excludedIngredientCount > 0) lines.push('', MISSING_CONVERSION_WARNING);

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
  totalsRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  cell: { padding: 4, lineHeight: 1.35 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

const MIN_COLUMN_WIDTH = 6;
const MAX_COLUMN_WIDTH = 40;

/** Same content-driven sizing rationale as pdf.ts's computeColumnWidths — a
 * long ingredient name shouldn't be squeezed into the same width as a
 * "Converted"/"Conversion Needed" status cell. */
function computeWidths(headers: string[], rows: (string | number)[][], totalRow: (string | number)[]): number[] {
  return headers.map((h, i) => {
    const longest = [...rows, totalRow].reduce((max, r) => Math.max(max, String(r[i] ?? '').length), h.length);
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, longest));
  });
}

function buildTable(headers: string[], rows: (string | number)[][], totalRow: (string | number)[]) {
  const widths = computeWidths(headers, rows, totalRow);
  const cellStyle = (i: number) => [styles.cell, { flex: widths[i] }];
  return e(
    View,
    { style: styles.table },
    e(View, { style: styles.headerRow, fixed: true }, ...headers.map((h, i) => e(Text, { key: i, style: cellStyle(i) }, h))),
    ...rows.map((r, i) =>
      e(
        View,
        { key: i, style: styles.row, wrap: false },
        ...r.map((v, j) => e(Text, { key: j, style: cellStyle(j) }, String(v))),
      ),
    ),
    e(View, { style: styles.totalsRow }, ...totalRow.map((v, j) => e(Text, { key: j, style: cellStyle(j) }, String(v)))),
  );
}

/**
 * PDF: exactly two tables — "Ingredient Weight Consumption (KG)" then
 * "Packaging Consumption (PC)" — each with its own totals row, plus a
 * missing-conversion warning line when applicable. No duplicate summary
 * cards.
 */
export async function generateInventorySummaryPdf(
  filters: ReportFilters,
  split: InventorySummarySplit,
  branchName: string | null,
): Promise<Buffer> {
  const { ingredientWeightKg, packagingPc, ingredientWeightTotalsKg, packagingTotalsPc, excludedIngredientCount } = split;
  const generatedAt = new Date().toISOString();
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom ? manilaDateKey(filters.dateFrom) : '...'} to ${filters.dateTo ? manilaDateKey(filters.dateTo) : '...'}`
      : 'All dates';

  const kgTable = buildTable(
    KG_HEADERS,
    ingredientWeightKg.map((r) => [
      r.ingredient_name,
      r.unit_code,
      r.opening_stock,
      r.consumed_today,
      r.consumed_this_month,
      r.remaining,
      kgCell(r.opening_stock_kg),
      kgCell(r.consumed_today_kg),
      kgCell(r.consumed_this_month_kg),
      kgCell(r.remaining_kg),
      statusLabel(r.status),
    ]),
    [
      'Total',
      '',
      '',
      '',
      '',
      '',
      ingredientWeightTotalsKg.opening_stock_kg,
      ingredientWeightTotalsKg.consumed_today_kg,
      ingredientWeightTotalsKg.consumed_this_month_kg,
      ingredientWeightTotalsKg.remaining_kg,
      '',
    ],
  );

  const pcTable = buildTable(
    PC_HEADERS,
    packagingPc.map((r) => [r.ingredient_name, r.opening_stock_pc, r.consumed_today_pc, r.consumed_this_month_pc, r.remaining_pc]),
    ['Total', packagingTotalsPc.opening_stock_pc, packagingTotalsPc.consumed_today_pc, packagingTotalsPc.consumed_this_month_pc, packagingTotalsPc.remaining_pc],
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
      e(Text, { style: styles.sectionTitle }, 'Ingredient Weight Consumption (KG)'),
      kgTable,
      e(Text, { style: styles.sectionTitle }, 'Packaging Consumption (PC)'),
      pcTable,
      ...(excludedIngredientCount > 0 ? [e(Text, { key: 'kg-warning', style: styles.meta }, MISSING_CONVERSION_WARNING)] : []),
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
