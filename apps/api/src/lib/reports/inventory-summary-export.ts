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

const MISSING_CONVERSION_WARNING = 'Some ingredients are excluded because no weight conversion is configured.';

export interface InventorySummarySplit {
  ingredientWeightKg: IngredientWeightKgRow[];
  packagingPc: PackagingPcRow[];
  ingredientWeightTotalsKg: IngredientWeightTotalsKg;
  packagingTotalsPc: PackagingTotalsPc;
  excludedIngredientCount: number;
}

const e = React.createElement;

const KG_HEADERS = ['Ingredient', 'Opening Stock (KG)', 'Consumed Today (KG)', 'Consumed This Month (KG)', 'Remaining (KG)'];
const PC_HEADERS = ['Packaging', 'Opening Stock (PC)', 'Consumed Today (PC)', 'Consumed This Month (PC)', 'Remaining (PC)'];

/**
 * CSV: exactly two sections — "Ingredient Weight Consumption (KG)" then
 * "Packaging Consumption (PC)", each with its own header row, data rows, and
 * a single Total row, separated by a blank line. No mixed native-unit
 * table, no duplicate KG summary section.
 */
export function generateInventorySummaryCsv(split: InventorySummarySplit): Buffer {
  const { ingredientWeightKg, packagingPc, ingredientWeightTotalsKg, packagingTotalsPc, excludedIngredientCount } = split;

  const lines = [
    'Ingredient Weight Consumption (KG)',
    KG_HEADERS.join(','),
    ...ingredientWeightKg.map((r) =>
      [r.ingredient_name, r.opening_stock_kg, r.consumed_today_kg, r.consumed_this_month_kg, r.remaining_kg].map(escapeCsvField).join(','),
    ),
    [
      'Total',
      ingredientWeightTotalsKg.opening_stock_kg,
      ingredientWeightTotalsKg.consumed_today_kg,
      ingredientWeightTotalsKg.consumed_this_month_kg,
      ingredientWeightTotalsKg.remaining_kg,
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
  cell: { flex: 1, padding: 4 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

function buildTable(headers: string[], rows: (string | number)[][], totalRow: (string | number)[]) {
  return e(
    View,
    { style: styles.table },
    e(View, { style: styles.headerRow }, ...headers.map((h, i) => e(Text, { key: i, style: styles.cell }, h))),
    ...rows.map((r, i) =>
      e(
        View,
        { key: i, style: styles.row, wrap: false },
        ...r.map((v, j) => e(Text, { key: j, style: styles.cell }, String(v))),
      ),
    ),
    e(View, { style: styles.totalsRow }, ...totalRow.map((v, j) => e(Text, { key: j, style: styles.cell }, String(v)))),
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
    ingredientWeightKg.map((r) => [r.ingredient_name, r.opening_stock_kg, r.consumed_today_kg, r.consumed_this_month_kg, r.remaining_kg]),
    ['Total', ingredientWeightTotalsKg.opening_stock_kg, ingredientWeightTotalsKg.consumed_today_kg, ingredientWeightTotalsKg.consumed_this_month_kg, ingredientWeightTotalsKg.remaining_kg],
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
