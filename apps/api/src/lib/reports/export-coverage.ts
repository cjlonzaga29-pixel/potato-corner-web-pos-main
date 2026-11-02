import { formatManilaDateTime } from '../manila-time.js';
import { formatPhp } from './expenses-export.js';

export interface ExportCoverage {
  partial: boolean;
  note: string;
}

interface CoverageTotal {
  label: string;
  amount: number;
}

interface CoverageSpec {
  /** Plural, for example "completed sales". */
  noun: string;
  /** The tab whose figures cover every match, named in a partial file. */
  screen: string;
  /** Undefined when a report's rows carry no date of their own. */
  newestAt: string | undefined;
  oldestAt: string | undefined;
  totals?: CoverageTotal[];
}

function sumAmounts<T>(rows: T[], amount: (row: T) => number): number {
  return rows.reduce((cents, row) => cents + Math.round(amount(row) * 100), 0) / 100;
}

/**
 * POS-PERF-P59 — what a report file covers, and which rows its totals describe.
 * `hasMore` comes from fetching one row past the limit, so a file holding exactly
 * the limit still reads as complete. Rows are newest first.
 */
export function exportCoverage(rowCount: number, hasMore: boolean, spec: CoverageSpec): ExportCoverage {
  const count = rowCount.toLocaleString('en-PH');
  const totals = spec.totals ?? [];
  if (!hasMore) {
    const totalNote = totals.map((total) => ` Total ${total.label} for all of them: ${formatPhp(total.amount)}.`).join('');
    return { partial: false, note: `Coverage: all ${count} matching ${spec.noun}.${totalNote}` };
  }
  const span = spec.newestAt && spec.oldestAt ? `, from ${formatManilaDateTime(spec.oldestAt)} to ${formatManilaDateTime(spec.newestAt)}` : '';
  const totalNote = totals.map((total) => `${total.label} for these exported rows only: ${formatPhp(total.amount)}. `).join('');
  return {
    partial: true,
    note:
      `PARTIAL EXPORT: this file holds only the newest ${count} matching ${spec.noun}${span}. ` +
      `More match these filters and are NOT in this file. ${totalNote}` +
      `For figures across all of them, use the ${spec.screen} screen or export a shorter date range.`,
  };
}

export function discountExportCoverage(rows: Array<{ discount_amount: number; created_at: string }>, hasMore: boolean): ExportCoverage {
  return exportCoverage(rows.length, hasMore, {
    noun: 'discounted sales',
    screen: 'Discount Report',
    newestAt: rows[0]?.created_at,
    oldestAt: rows[rows.length - 1]?.created_at,
    totals: [{ label: 'Discount Amount', amount: sumAmounts(rows, (row) => row.discount_amount) }],
  });
}

export function dailySalesExportCoverage(rows: Array<{ total_amount: number; discount_amount: number; created_at: string }>, hasMore: boolean): ExportCoverage {
  return exportCoverage(rows.length, hasMore, {
    noun: 'completed sales',
    screen: 'Daily Sales Report',
    newestAt: rows[0]?.created_at,
    oldestAt: rows[rows.length - 1]?.created_at,
    totals: [
      { label: 'Sales', amount: sumAmounts(rows, (row) => row.total_amount) },
      { label: 'Discounts', amount: sumAmounts(rows, (row) => row.discount_amount) },
    ],
  });
}

/** Voided and refunded rows can share this file, so its total is only the sales still completed. */
export function soldProductsExportCoverage(rows: Array<{ total_amount: number; status: string; created_at: string }>, hasMore: boolean): ExportCoverage {
  return exportCoverage(rows.length, hasMore, {
    noun: 'sold product transactions',
    screen: 'Sold Product Transactions',
    newestAt: rows[0]?.created_at,
    oldestAt: rows[rows.length - 1]?.created_at,
    totals: [{ label: 'Completed Sales', amount: sumAmounts(rows.filter((row) => row.status === 'completed'), (row) => row.total_amount) }],
  });
}

export function voidRefundExportCoverage(rows: Array<{ total_amount: number; status: string; created_at: string }>, hasMore: boolean): ExportCoverage {
  return exportCoverage(rows.length, hasMore, {
    noun: 'voided or refunded sales',
    screen: 'Void/Refund',
    newestAt: rows[0]?.created_at,
    oldestAt: rows[rows.length - 1]?.created_at,
    totals: [
      { label: 'Voided Amount', amount: sumAmounts(rows.filter((row) => row.status === 'voided'), (row) => row.total_amount) },
      { label: 'Refunded Amount', amount: sumAmounts(rows.filter((row) => row.status === 'refunded'), (row) => row.total_amount) },
    ],
  });
}
