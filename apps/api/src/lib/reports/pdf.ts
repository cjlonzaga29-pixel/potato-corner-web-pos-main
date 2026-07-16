// apps/api/src/lib/reports/pdf.ts
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReportColumn, ReportFilters } from '../../modules/reports/reports.types.js';
import type { ReportType } from '@potato-corner/shared';

const e = React.createElement;

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 9, fontFamily: 'Helvetica' },
  header: { marginBottom: 12 },
  brand: { fontSize: 14, fontWeight: 700 },
  title: { fontSize: 11, marginTop: 2 },
  meta: { fontSize: 8, color: '#444444', marginTop: 2 },
  table: { display: 'flex', width: '100%', borderTop: '1px solid #000000' },
  row: { flexDirection: 'row', borderBottom: '1px solid #cccccc' },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  cell: { flex: 1, padding: 4 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

function reportTypeLabel(reportType: ReportType): string {
  return reportType
    .split('_')
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Black-and-white, legible, minimal — matches the spec's "no color styling
 * needed for reports." Header: brand name (logo placeholder), report title,
 * branch, date range, generated timestamp. Footer: "Page X of Y" via
 * @react-pdf/renderer's `render` prop, which re-runs per rendered page.
 */
export async function generatePdf<T extends Record<string, unknown>>(
  reportType: ReportType,
  filters: ReportFilters,
  data: T[],
  columns: Array<ReportColumn<T>>,
  branchName: string | null,
): Promise<Buffer> {
  const visibleColumns = columns.filter((c) => !c.isAudit);
  const generatedAt = new Date().toISOString();
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom?.toISOString().slice(0, 10) ?? '...'} to ${filters.dateTo?.toISOString().slice(0, 10) ?? '...'}`
      : 'All dates';

  const headerCells = visibleColumns.map((c) => e(Text, { key: String(c.key), style: styles.cell }, c.header));
  const bodyRows = data.map((row, i) =>
    e(
      View,
      { key: i, style: styles.row, wrap: false },
      ...visibleColumns.map((c) => e(Text, { key: String(c.key), style: styles.cell }, String(row[c.key] ?? ''))),
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
        e(Text, { style: styles.title }, `${reportTypeLabel(reportType)} Report`),
        e(Text, { style: styles.meta }, `Branch: ${branchName ?? 'All Branches'} | Date range: ${dateRangeLabel} | Generated: ${generatedAt}`),
      ),
      e(
        View,
        { style: styles.table },
        e(View, { style: styles.headerRow, fixed: true }, ...headerCells),
        ...bodyRows,
      ),
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );

  return renderToBuffer(doc as never);
}
