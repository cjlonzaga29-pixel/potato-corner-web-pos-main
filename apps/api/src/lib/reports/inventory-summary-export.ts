// apps/api/src/lib/reports/inventory-summary-export.ts
//
// Task 144: the Inventory Summary report renders as a single "Ingredient
// Consumption" table — every inventory item in its own stored base unit,
// never converted (no kg conversion, no CONVERSION_REQUIRED status, no
// ingredient/packaging section split). The generic column-based generateCsv/
// generatePdf (lib/reports/csv.ts, lib/reports/pdf.ts) assume one totals row
// per whole report, but totals here must be grouped per unit (never mixing
// units together), so this report keeps its own dedicated builders instead
// of a REPORT_COLUMNS entry.
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

export interface UnitTotal {
  unit: string;
  opening_stock: number;
  consumed_today: number;
  consumed_this_month: number;
  remaining_stock: number;
}

/** Totals grouped by unit, in first-appearance order — rows with different units are never summed together. */
export function groupTotalsByUnit(rows: InventorySummaryReportRow[]): UnitTotal[] {
  const totalsByUnit = new Map<string, UnitTotal>();
  for (const r of rows) {
    const existing = totalsByUnit.get(r.unit);
    if (existing) {
      existing.opening_stock = round2(existing.opening_stock + r.opening_stock);
      existing.consumed_today = round2(existing.consumed_today + r.consumed_today);
      existing.consumed_this_month = round2(existing.consumed_this_month + r.consumed_this_month);
      existing.remaining_stock = round2(existing.remaining_stock + r.remaining_stock);
    } else {
      totalsByUnit.set(r.unit, {
        unit: r.unit,
        opening_stock: r.opening_stock,
        consumed_today: r.consumed_today,
        consumed_this_month: r.consumed_this_month,
        remaining_stock: r.remaining_stock,
      });
    }
  }
  return Array.from(totalsByUnit.values());
}

const HEADERS = ['Ingredient', 'Unit', 'Opening Stock', 'Consumed Today', 'Consumed This Month', 'Remaining'];

/** CSV: one "Ingredient Consumption" table — every row in its own unit — followed by one Total line per distinct unit. */
export function generateInventorySummaryCsv(rows: InventorySummaryReportRow[]): Buffer {
  const totals = groupTotalsByUnit(rows);

  const lines = [
    'Ingredient Consumption',
    HEADERS.join(','),
    ...rows.map((r) => [r.ingredient_name, r.unit, r.opening_stock, r.consumed_today, r.consumed_this_month, r.remaining_stock].map(escapeCsvField).join(',')),
    ...totals.map((t) =>
      [`Total (${t.unit})`, '', t.opening_stock, t.consumed_today, t.consumed_this_month, t.remaining_stock].map(escapeCsvField).join(','),
    ),
  ];

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

/** PDF: one document — title header, then the "Ingredient Consumption" table with every row in its own unit, followed by one Total row per distinct unit. */
export async function generateInventorySummaryPdf(filters: ReportFilters, rows: InventorySummaryReportRow[], branchName: string | null): Promise<Buffer> {
  const totals = groupTotalsByUnit(rows);
  const generatedAt = new Date().toISOString();
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom ? manilaDateKey(filters.dateFrom) : '...'} to ${filters.dateTo ? manilaDateKey(filters.dateTo) : '...'}`
      : 'All dates';

  const table = e(
    View,
    { style: styles.table },
    e(View, { style: styles.headerRow }, ...HEADERS.map((h, i) => e(Text, { key: i, style: styles.cell }, h))),
    ...rows.map((r, i) =>
      e(
        View,
        { key: i, style: styles.row, wrap: false },
        ...[r.ingredient_name, r.unit, r.opening_stock, r.consumed_today, r.consumed_this_month, r.remaining_stock].map((v, j) =>
          e(Text, { key: j, style: styles.cell }, String(v)),
        ),
      ),
    ),
    ...totals.map((t, i) =>
      e(
        View,
        { key: `total-${i}`, style: styles.totalsRow },
        ...[`Total (${t.unit})`, '', t.opening_stock, t.consumed_today, t.consumed_this_month, t.remaining_stock].map((v, j) =>
          e(Text, { key: j, style: styles.cell }, String(v)),
        ),
      ),
    ),
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
      e(Text, { style: styles.sectionTitle }, 'Ingredient Consumption'),
      table,
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
