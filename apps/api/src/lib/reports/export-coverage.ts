import { formatManilaDateTime } from '../manila-time.js';
import { formatPhp } from './expenses-export.js';

export interface ExportCoverage {
  partial: boolean;
  note: string;
}

/**
 * POS-PERF-P59 — what a Discount Report file covers, and which rows its total
 * describes. `hasMore` comes from fetching one row past the limit, so a file
 * holding exactly the limit still reads as complete. Rows are newest first.
 */
export function discountExportCoverage(rows: Array<{ discount_amount: number; created_at: string }>, hasMore: boolean): ExportCoverage {
  const cents = rows.reduce((sum, row) => sum + Math.round(row.discount_amount * 100), 0);
  const total = formatPhp(cents / 100);
  const count = rows.length.toLocaleString('en-PH');
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  if (!hasMore || !newest || !oldest) {
    return { partial: false, note: `Coverage: all ${count} matching discounted sales. Total Discount Amount for all of them: ${total}.` };
  }
  return {
    partial: true,
    note:
      `PARTIAL EXPORT: this file holds only the newest ${count} matching discounted sales, from ${formatManilaDateTime(oldest.created_at)} to ${formatManilaDateTime(newest.created_at)}. ` +
      `More sales match these filters and are NOT in this file. Discount Amount for these exported rows only: ${total}. ` +
      'For totals across all matching sales, use the Discount Report screen or export a shorter date range.',
  };
}
