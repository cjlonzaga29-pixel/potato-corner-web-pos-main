import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { PayrollEmployeeResult, PayrollRunDetail } from '@potato-corner/shared';
import { formatDuration, msToMinutesText } from './payroll-money.js';
import { formatBusinessDateTime } from './payroll-time.js';

/**
 * POS-PERF-P52 — payroll CSV/PDF. Both are rendered from the same
 * PayrollRunDetail the screen shows: for a finalized run that is the stored
 * snapshot (never recalculated), so the file's figures are exactly the
 * finalized record's. A draft export is labelled DRAFT on every page/row.
 * No government IDs, PINs, contact details or other employee data appear —
 * only name, employee code and the payroll figures.
 */

const NUMERIC = /^-?\d+(\.\d+)?$/;
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Spreadsheet-safe CSV cell. Free text that a spreadsheet would read as a
 * formula (leading = + - @ tab CR) is prefixed with an apostrophe. Values we
 * produce as plain decimal numbers are left numeric.
 */
export function csvCell(value: string | number | null | undefined, numeric = false): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (!(numeric && NUMERIC.test(text)) && text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0))) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function row(cells: Array<string | number | null | undefined | { n: string }>): string {
  return cells.map((c) => (c !== null && typeof c === 'object' ? csvCell(c.n, true) : csvCell(c))).join(',');
}

export function statusLabel(detail: PayrollRunDetail): string {
  if (detail.status === 'draft') return 'DRAFT — NOT FINALIZED';
  if (detail.status === 'discarded') return 'DISCARDED DRAFT — NOT FINALIZED';
  if (detail.status === 'superseded') return 'SUPERSEDED — replaced by a revision';
  return detail.paid_at ? 'FINALIZED — MARKED PAID' : 'FINALIZED — NOT YET MARKED PAID';
}

function policyText(detail: PayrollRunDetail): string {
  const p = detail.policy;
  if (!p) return 'Not configured';
  const period = p.period_type === 'monthly' ? 'monthly' : `semi-monthly (cutoff day ${p.semi_monthly_first_end_day ?? '?'})`;
  const breaks =
    p.break_treatment === 'paid'
      ? 'breaks paid'
      : p.break_treatment === 'unpaid'
        ? 'breaks unpaid'
        : `first ${p.paid_break_limit_minutes ?? 0} break minutes per shift paid, rest unpaid`;
  return `v${p.version}, ${p.timezone}, ${period}, ${breaks}`;
}

function rateText(e: PayrollEmployeeResult): string {
  return e.rate_lines.map((l) => `${msToMinutesText(l.payable_ms)} min @ ${l.hourly_rate}/h = ${l.amount}`).join('; ');
}

function tz(detail: PayrollRunDetail): string {
  return detail.policy?.timezone ?? 'UTC';
}

export function buildPayrollCsv(detail: PayrollRunDetail): Buffer {
  const zone = tz(detail);
  const lines: string[] = [];
  lines.push(row(['Payroll report', statusLabel(detail)]));
  lines.push(row(['Branch', detail.branch_name]));
  lines.push(row(['Pay period', `${detail.period_start} to ${detail.period_end}`]));
  lines.push(row(['Revision', String(detail.revision_number)]));
  lines.push(row([detail.status === 'draft' ? 'Calculated at (live draft)' : 'Finalized at', formatBusinessDateTime(detail.calculated_at, zone)]));
  if (detail.finalized_by_name) lines.push(row(['Finalized by', detail.finalized_by_name]));
  if (detail.paid_at) lines.push(row(['Marked paid', `${formatBusinessDateTime(detail.paid_at, zone)} by ${detail.paid_by_name ?? ''}${detail.paid_reference ? ` (ref ${detail.paid_reference})` : ''}`]));
  if (detail.fingerprint) lines.push(row(['Fingerprint', detail.fingerprint]));
  lines.push(row(['Policy', policyText(detail)]));
  if (detail.employee_filter) lines.push(row(['Filtered to one employee', 'yes']));
  lines.push(row(['Not included', detail.exclusions.join('; ')]));
  lines.push('');

  lines.push(row(['Employee', 'Employee code', 'Payable minutes', 'Payable time', 'Rate breakdown', 'Basic pay', 'Earnings adjustments', 'Deductions', detail.total_label, 'Status']));
  for (const e of detail.employees) {
    lines.push(
      row([
        e.name,
        e.employee_code,
        { n: msToMinutesText(e.payable_ms) },
        formatDuration(e.payable_ms),
        rateText(e),
        { n: e.basic_pay },
        { n: e.earnings_adjustments },
        { n: e.deductions },
        { n: e.calculated_total },
        detail.status === 'finalized' || detail.status === 'superseded' ? detail.status.toUpperCase() : 'DRAFT',
      ]),
    );
  }
  lines.push(
    row([
      'TOTAL',
      '',
      { n: msToMinutesText(detail.totals.payable_ms) },
      formatDuration(detail.totals.payable_ms),
      '',
      { n: detail.totals.basic_pay },
      { n: detail.totals.earnings_adjustments },
      { n: detail.totals.deductions },
      { n: detail.totals.calculated_total },
      detail.status === 'finalized' || detail.status === 'superseded' ? detail.status.toUpperCase() : 'DRAFT',
    ]),
  );
  lines.push('');

  lines.push(row(['Employee', 'Business date', 'Clock in', 'Clock out', 'Shift span (min)', 'Break source', 'Breaks', 'Unpaid break (min)', 'Payable (min)', 'Rates applied', 'Flags']));
  for (const e of detail.employees) {
    for (const s of e.shifts) {
      const breaks = s.breaks
        .map((b) =>
          b.source === 'legacy_total'
            ? `legacy total ${b.minutes} min (paid ${b.paid_minutes}, unpaid ${b.unpaid_minutes})`
            : `${b.started_at ? formatBusinessDateTime(b.started_at, zone) : '?'}–${b.ended_at ? formatBusinessDateTime(b.ended_at, zone) : 'open'} ${b.minutes} min (paid ${b.paid_minutes}, unpaid ${b.unpaid_minutes})`,
        )
        .join('; ');
      const rates = s.segments.map((seg) => `${seg.business_date}: ${msToMinutesText(seg.payable_ms)} min @ ${seg.hourly_rate ?? 'NO RATE'}`).join('; ');
      lines.push(
        row([
          e.name,
          s.business_date,
          formatBusinessDateTime(s.clock_in, zone),
          s.clock_out ? formatBusinessDateTime(s.clock_out, zone) : 'OPEN (no clock-out)',
          { n: msToMinutesText(s.span_ms) },
          s.break_source,
          breaks,
          { n: msToMinutesText(s.unpaid_break_ms) },
          { n: msToMinutesText(s.payable_ms) },
          rates,
          [...s.issue_codes, ...(s.note ? [s.note] : [])].join('; '),
        ]),
      );
    }
  }
  lines.push('');

  lines.push(row(['Employee', 'Adjustment type', 'Category', 'Amount', 'Reason', 'Documentation reference', 'Entered by', 'Entered at', 'Voided']));
  for (const e of detail.employees) {
    for (const a of e.adjustments) {
      lines.push(
        row([
          e.name,
          a.kind === 'earning' ? 'Earning' : 'Deduction',
          a.category,
          { n: a.amount },
          a.reason,
          a.documentation_ref,
          a.created_by_name,
          formatBusinessDateTime(a.created_at, zone),
          a.voided_at ? `Voided: ${a.void_reason ?? ''}` : '',
        ]),
      );
    }
  }
  lines.push('');

  lines.push(row(['Issue', 'Severity', 'Employee', 'Business date', 'Message', 'Resolution']));
  const names = new Map(detail.employees.map((e) => [e.employee_id, e.name]));
  for (const i of detail.issues) {
    lines.push(
      row([
        i.code,
        i.severity,
        i.employee_id ? (names.get(i.employee_id) ?? '') : '',
        i.business_date,
        i.message,
        i.resolution ? `${i.resolution.note} — ${i.resolution.by}` : '',
      ]),
    );
  }
  // UTF-8 BOM so spreadsheet apps read non-ASCII names correctly.
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const e = React.createElement;

const styles = StyleSheet.create({
  page: { paddingTop: 54, paddingBottom: 40, paddingHorizontal: 28, fontFamily: 'Helvetica', fontSize: 8 },
  pageHeader: { position: 'absolute', top: 18, left: 28, right: 28, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#444444' },
  status: { fontSize: 9, fontWeight: 700 },
  draftBanner: { borderWidth: 1, borderColor: '#000000', padding: 4, marginBottom: 6, fontSize: 10, fontWeight: 700, textAlign: 'center' },
  title: { fontSize: 13, fontWeight: 700 },
  meta: { fontSize: 8, color: '#333333', marginTop: 2 },
  box: { borderWidth: 1, borderColor: '#999999', padding: 5, marginTop: 6, marginBottom: 6 },
  sectionTitle: { fontSize: 10, fontWeight: 700, marginTop: 8, marginBottom: 3 },
  table: { borderTopWidth: 1, borderTopColor: '#000000' },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#000000', fontWeight: 700 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#bbbbbb' },
  totalRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#000000', fontWeight: 700 },
  cell: { padding: 3, lineHeight: 1.3 },
  footer: { position: 'absolute', bottom: 16, left: 28, right: 28, fontSize: 7, textAlign: 'center', color: '#555555' },
});

/** Lets very long unbroken tokens (names, references) wrap inside a narrow PDF column. */
export function wrapLongTokens(text: string, max = 18): string {
  return text.replace(new RegExp(`(\\S{${max}})(?=\\S)`, 'g'), '$1\u200B');
}

interface Col {
  header: string;
  width: number;
  align?: 'right';
}

function table(cols: Col[], rows: string[][], totalRow?: string[]) {
  const cell = (text: string, col: Col, key: number) =>
    e(Text, { key, style: [styles.cell, { width: `${col.width}%`, textAlign: col.align ?? 'left' }] }, wrapLongTokens(text));
  return e(
    View,
    { style: styles.table },
    e(View, { style: styles.headRow, fixed: true }, ...cols.map((c, i) => cell(c.header, c, i))),
    ...rows.map((r, ri) => e(View, { key: ri, style: styles.row, wrap: false }, ...cols.map((c, i) => cell(r[i] ?? '', c, i)))),
    ...(totalRow ? [e(View, { key: 'total', style: styles.totalRow, wrap: false }, ...cols.map((c, i) => cell(totalRow[i] ?? '', c, i)))] : []),
  );
}

export async function buildPayrollPdf(detail: PayrollRunDetail): Promise<Buffer> {
  const zone = tz(detail);
  const label = statusLabel(detail);
  const isDraft = detail.status === 'draft' || detail.status === 'discarded';
  const names = new Map(detail.employees.map((x) => [x.employee_id, x.name]));

  const summaryCols: Col[] = [
    { header: 'Employee', width: 22 },
    { header: 'Payable time', width: 12 },
    { header: 'Rate breakdown', width: 24 },
    { header: 'Basic pay', width: 10, align: 'right' },
    { header: 'Earnings adj.', width: 10, align: 'right' },
    { header: 'Deductions', width: 10, align: 'right' },
    { header: 'Calculated total*', width: 12, align: 'right' },
  ];
  const summaryRows = detail.employees.map((x) => [
    `${x.name}${x.employee_code ? `\n${x.employee_code}` : ''}`,
    `${formatDuration(x.payable_ms)}\n${msToMinutesText(x.payable_ms)} min`,
    rateText(x) || '—',
    x.basic_pay,
    x.earnings_adjustments,
    x.deductions,
    x.calculated_total,
  ]);

  const shiftCols: Col[] = [
    { header: 'Date', width: 10 },
    { header: 'Clock in', width: 13 },
    { header: 'Clock out', width: 13 },
    { header: 'Span (min)', width: 8, align: 'right' },
    { header: 'Breaks & treatment', width: 26 },
    { header: 'Payable (min)', width: 9, align: 'right' },
    { header: 'Rate(s)', width: 11 },
    { header: 'Flags', width: 10 },
  ];

  const employeeSections = detail.employees.map((x) =>
    e(
      View,
      { key: x.employee_id },
      e(Text, { style: styles.sectionTitle, minPresenceAhead: 40 }, wrapLongTokens(`${x.name}${x.employee_code ? ` (${x.employee_code})` : ''} — ${detail.total_label}: ${x.calculated_total}`)),
      table(
        shiftCols,
        x.shifts.map((s) => [
          s.business_date,
          formatBusinessDateTime(s.clock_in, zone),
          s.clock_out ? formatBusinessDateTime(s.clock_out, zone) : 'OPEN',
          msToMinutesText(s.span_ms),
          s.breaks.length === 0
            ? 'none'
            : s.breaks
                .map((b) =>
                  b.source === 'legacy_total'
                    ? `legacy total ${b.minutes} min: paid ${b.paid_minutes} / unpaid ${b.unpaid_minutes}`
                    : `${b.started_at ? formatBusinessDateTime(b.started_at, zone).slice(11) : '?'}–${b.ended_at ? formatBusinessDateTime(b.ended_at, zone).slice(11) : 'open'}: paid ${b.paid_minutes} / unpaid ${b.unpaid_minutes}`,
                )
                .join('\n'),
          msToMinutesText(s.payable_ms),
          [...new Set(s.segments.map((seg) => seg.hourly_rate ?? 'NO RATE'))].join(', '),
          [...s.issue_codes, ...(s.note ? [s.note] : [])].join(', '),
        ]),
      ),
      ...(x.adjustments.length > 0
        ? [
            table(
              [
                { header: 'Adjustment', width: 18 },
                { header: 'Amount', width: 10, align: 'right' },
                { header: 'Reason / documentation', width: 52 },
                { header: 'Entered by', width: 20 },
              ],
              x.adjustments.map((a) => [
                `${a.kind === 'earning' ? 'Earning' : 'Deduction'}: ${a.category}${a.voided_at ? ' (VOIDED)' : ''}`,
                a.amount,
                `${a.reason}${a.documentation_ref ? ` — ref: ${a.documentation_ref}` : ''}${a.voided_at ? ` — voided: ${a.void_reason ?? ''}` : ''}`,
                a.created_by_name,
              ]),
            ),
          ]
        : []),
    ),
  );

  const doc = e(
    Document,
    { title: `Payroll ${detail.branch_name} ${detail.period_start} to ${detail.period_end}` },
    e(
      Page,
      { size: 'A4', orientation: 'landscape', style: styles.page },
      e(
        View,
        { style: styles.pageHeader, fixed: true },
        e(Text, null, `POTATO CORNER — Payroll — ${detail.branch_name} — ${detail.period_start} to ${detail.period_end}`),
        e(Text, { style: styles.status }, label),
      ),
      ...(isDraft ? [e(Text, { style: styles.draftBanner }, 'DRAFT — NOT FINALIZED. Figures are recalculated live and may change. Not a payroll record.')] : []),
      e(Text, { style: styles.title }, 'Attendance-based payroll report'),
      e(
        Text,
        { style: styles.meta },
        `Branch: ${detail.branch_name} | Pay period: ${detail.period_start} to ${detail.period_end} | Revision ${detail.revision_number} | ${
          isDraft ? `Calculated ${formatBusinessDateTime(detail.calculated_at, zone)}` : `Finalized ${formatBusinessDateTime(detail.calculated_at, zone)} by ${detail.finalized_by_name ?? ''}`
        }${detail.paid_at ? ` | Marked paid ${formatBusinessDateTime(detail.paid_at, zone)}` : ''}`,
      ),
      e(Text, { style: styles.meta }, `Policy: ${policyText(detail)}${detail.fingerprint ? ` | Fingerprint ${detail.fingerprint.slice(0, 16)}…` : ''}`),
      e(
        View,
        { style: styles.box },
        e(Text, null, `* ${detail.total_label}. This is basic time-based pay. NOT included: ${detail.exclusions.join('; ')}.`),
      ),
      e(Text, { style: styles.sectionTitle }, 'Summary'),
      table(summaryCols, summaryRows, [
        'TOTAL',
        `${formatDuration(detail.totals.payable_ms)}\n${msToMinutesText(detail.totals.payable_ms)} min`,
        '',
        detail.totals.basic_pay,
        detail.totals.earnings_adjustments,
        detail.totals.deductions,
        detail.totals.calculated_total,
      ]),
      e(Text, { style: styles.sectionTitle, break: detail.employees.length > 8 }, 'Employee detail'),
      ...employeeSections,
      ...(detail.issues.length > 0
        ? [
            e(Text, { key: 'issues-title', style: styles.sectionTitle }, 'Issues and review notes'),
            table(
              [
                { header: 'Issue', width: 16 },
                { header: 'Employee', width: 18 },
                { header: 'Message', width: 44 },
                { header: 'Resolution', width: 22 },
              ],
              detail.issues.map((i) => [
                `${i.code} (${i.severity})`,
                i.employee_id ? (names.get(i.employee_id) ?? '') : '',
                `${i.business_date ? `${i.business_date}: ` : ''}${i.message}`,
                i.resolution ? `${i.resolution.note} — ${i.resolution.by}` : '',
              ]),
            ),
          ]
        : []),
      e(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${label} — Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );
  return renderToBuffer(doc as never);
}

export function payrollExportFilename(detail: PayrollRunDetail, format: 'csv' | 'pdf'): string {
  const status = detail.status === 'draft' || detail.status === 'discarded' ? 'DRAFT' : detail.status === 'superseded' ? 'SUPERSEDED' : 'FINAL';
  const branch = detail.branch_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'branch';
  return `Payroll_${branch}_${detail.period_start}_to_${detail.period_end}_r${detail.revision_number}_${status}.${format}`;
}
