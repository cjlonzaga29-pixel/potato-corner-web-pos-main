// apps/api/src/lib/reports/pdf.ts
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { ReportColumn, ReportFilters } from '../../modules/reports/reports.types.js';
import type { ReportType } from '@potato-corner/shared';
import { manilaDateKey, formatManilaDateTime } from '../manila-time.js';

const e = React.createElement;

const styles = StyleSheet.create({
  page: { padding: 24, fontFamily: 'Helvetica' },
  header: { marginBottom: 12 },
  brand: { fontSize: 14, fontWeight: 700 },
  title: { fontSize: 11, marginTop: 2 },
  meta: { fontSize: 8, color: '#444444', marginTop: 2 },
  table: { display: 'flex', width: '100%', borderTop: '1px solid #000000' },
  row: { flexDirection: 'row', borderBottom: '1px solid #cccccc' },
  headerRow: { flexDirection: 'row', borderBottom: '1px solid #000000', fontWeight: 700 },
  cell: { padding: 4, lineHeight: 1.35 },
  footer: { position: 'absolute', bottom: 16, left: 24, right: 24, fontSize: 8, textAlign: 'center', color: '#666666' },
});

function reportTypeLabel(reportType: ReportType): string {
  return reportType
    .split('_')
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');
}

// Matches the exact `.toISOString()` shape every report repository stores
// timestamps in (e.g. created_at, closed_at, actioned_at). Rendering that
// raw 24-char string in a narrow PDF column is what produced the reported
// "Date/Time wraps badly and collides with the next column" bug — it has no
// good line-break points and is far longer than it needs to be for a
// printed report. Reformatting to Manila local time is display-only; the
// underlying row value (and the CSV export) are untouched.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && ISO_DATETIME_RE.test(value)) {
    return formatManilaDateTime(value);
  }
  return String(value);
}

const WIDTH_SAMPLE_SIZE = 200;
const CELL_PADDING_PT = 8; // 4pt each side, matches styles.cell
const PAGE_MARGIN_PT = 24; // matches styles.page
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MAX_IDEAL_COLUMN_PT = 260; // caps how much one free-text column (e.g. a long "reason") can claim before it's expected to wrap
const FONT_SIZE_CANDIDATES = [9, 8, 7] as const;

/**
 * Rough Helvetica glyph widths (em units — multiply by font size for pt),
 * deliberately generous/rounded up per class rather than exact per-glyph
 * metrics: this only has to avoid *underestimating* width (which is what
 * causes overlap), a little extra whitespace is harmless. Digits and
 * uppercase letters — the bulk of receipt numbers and reference IDs — are
 * noticeably wider than lowercase prose, which a flat "1 char = 1 unit"
 * count was blind to; that's what let a 26-character receipt number
 * overflow a column sized for it as if every character were narrow.
 */
function charWidthEm(ch: string): number {
  if (ch === ' ') return 0.28;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch >= 'A' && ch <= 'Z') return 0.67;
  if (ch === '-' || ch === '_' || ch === '.' || ch === ',' || ch === ':' || ch === '/' || ch === "'") return 0.33;
  return 0.52; // lowercase and everything else
}

export function estimateTextWidthPt(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += charWidthEm(ch);
  return em * fontSize;
}

/** react-pdf (like most text layout engines) only wraps at whitespace — a
 * hyphen-joined receipt number or reference ID never breaks, so the column
 * must be at least as wide as that single longest unbroken run or the text
 * overflows straight into the next column. */
function longestUnbreakableToken(text: string): string {
  return text.split(/\s+/).reduce((longest, token) => (token.length > longest.length ? token : longest), '');
}

interface ColumnLayout {
  fontSize: number;
  widths: number[];
}

/**
 * Content-driven column sizing instead of a uniform `flex: 1` per column
 * (the old behavior, which let a 26-character receipt number and a
 * 2-character "Yes"/"No" cell fight for the same width). Every column first
 * gets a hard-floor width wide enough to fit its longest *unbreakable*
 * token — guaranteeing no overlap regardless of what the other columns
 * need — then whatever page width is left over is handed out to columns
 * that can still use it (their full value is longer than their floor, and
 * they have real wrap points to grow into on a second line). Font size
 * steps down (never below 7pt) only if even the hard floors don't fit at a
 * larger size. Sampling actual row content — not just the header — is what
 * makes this work for every report without hand-tuning column widths one
 * report at a time.
 */
export function computeColumnLayout<T extends Record<string, unknown>>(
  columns: Array<ReportColumn<T>>,
  data: T[],
  orientation: 'portrait' | 'landscape',
): ColumnLayout {
  const pageWidthPt = orientation === 'landscape' ? A4_HEIGHT_PT : A4_WIDTH_PT;
  const usableWidthPt = pageWidthPt - PAGE_MARGIN_PT * 2;
  const sample = data.length > WIDTH_SAMPLE_SIZE ? data.slice(0, WIDTH_SAMPLE_SIZE) : data;

  // Smallest candidate as the initial fallback — the loop below always runs
  // at least once and overwrites this, but a literal (not computed) index
  // keeps TS's strict indexed-access check satisfied.
  let fontSize: (typeof FONT_SIZE_CANDIDATES)[number] = FONT_SIZE_CANDIDATES[2];
  let minPts: number[] = [];
  let idealPts: number[] = [];

  for (const candidate of FONT_SIZE_CANDIDATES) {
    minPts = columns.map((c) => {
      const longestToken = sample.reduce(
        (longest, row) => {
          const token = longestUnbreakableToken(formatCellValue(row[c.key]));
          return token.length > longest.length ? token : longest;
        },
        longestUnbreakableToken(c.header),
      );
      return estimateTextWidthPt(longestToken, candidate) + CELL_PADDING_PT;
    });
    idealPts = columns.map((c, i) => {
      const longestValue = sample.reduce((longest, row) => {
        const value = formatCellValue(row[c.key]);
        return value.length > longest.length ? value : longest;
      }, c.header);
      const idealPt = estimateTextWidthPt(longestValue, candidate) + CELL_PADDING_PT;
      return Math.max(minPts[i] ?? 0, Math.min(idealPt, MAX_IDEAL_COLUMN_PT));
    });

    fontSize = candidate;
    const hardFloorTotal = minPts.reduce((sum, w) => sum + w, 0);
    if (hardFloorTotal <= usableWidthPt) break; // fits without overlap risk — stop shrinking further
  }

  const hardFloorTotal = minPts.reduce((sum, w) => sum + w, 0);
  const leftover = Math.max(0, usableWidthPt - hardFloorTotal);
  const demand = idealPts.map((ideal, i) => Math.max(0, ideal - (minPts[i] ?? 0)));
  const totalDemand = demand.reduce((sum, d) => sum + d, 0);

  const widths = minPts.map((minPt, i) => {
    if (totalDemand <= 0) return minPt + leftover / minPts.length;
    return minPt + leftover * ((demand[i] ?? 0) / totalDemand);
  });

  return { fontSize, widths };
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
  // filters.dateFrom/dateTo are Manila day-boundary UTC instants (see
  // reports.router.ts's toBoundaryDate) — .toISOString().slice(0, 10) would
  // print the UTC date, which is one calendar day behind the Manila date at
  // dateFrom's exact midnight instant.
  const dateRangeLabel =
    filters.dateFrom || filters.dateTo
      ? `${filters.dateFrom ? manilaDateKey(filters.dateFrom) : '...'} to ${filters.dateTo ? manilaDateKey(filters.dateTo) : '...'}`
      : 'All dates';

  // Narrow reports (few columns) stay portrait; reports with enough columns
  // to need the extra horizontal room (Discount Compliance and its 9
  // columns, Shift Summary's 16, etc.) render landscape.
  const orientation: 'portrait' | 'landscape' = visibleColumns.length > 6 ? 'landscape' : 'portrait';
  const { fontSize: bodyFontSize, widths: columnWidths } = computeColumnLayout(visibleColumns, data, orientation);

  const headerCells = visibleColumns.map((c, i) =>
    e(Text, { key: String(c.key), style: [styles.cell, { width: columnWidths[i] }] }, c.header),
  );
  const bodyRows = data.map((row, i) =>
    e(
      View,
      { key: i, style: styles.row, wrap: false },
      ...visibleColumns.map((c, ci) =>
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
