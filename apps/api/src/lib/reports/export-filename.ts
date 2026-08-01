import type { ReportType } from '@potato-corner/shared';
import type { ReportFilters } from '../../modules/reports/reports.types.js';
import { manilaDateKey } from '../manila-time.js';

/** DAILY_SALES -> DailySales */
function pascalCase(reportType: ReportType): string {
  return reportType
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Manila calendar date, not date.toISOString().slice(0, 10) — that reads the
 * UTC calendar day, which is a day early for a Manila day-*start* boundary
 * (e.g. Manila 2026-07-30 00:00 is 2026-07-29T16:00:00.000Z; see
 * lib/manila-time.ts's own warning against this exact pattern). Only bites
 * when date_to is omitted and this falls back to date_from's start-of-day
 * boundary — date_to's end-of-day boundary happens to land on the same UTC
 * calendar date, so the common case was never visibly wrong.
 */
function toDateStamp(date: Date | undefined): string {
  return manilaDateKey(date ?? new Date());
}

/**
 * User-facing download filename for a report export — e.g.
 * `DailySales_2026-07-24_to_2026-07-30.csv` when both bounds of the range are
 * known, falling back to a single date stamp (or today) when one or both are
 * missing. Distinct from the Supabase Storage object path
 * (`reports/{userId}/{timestamp}-{type}.{ext}`, still used by the async/
 * large-report path), which only needs to be unique, not readable.
 */
export function buildExportFilename(reportType: ReportType, format: 'csv' | 'pdf', filters: ReportFilters): string {
  const name = pascalCase(reportType);
  if (filters.dateFrom && filters.dateTo) {
    const from = toDateStamp(filters.dateFrom);
    const to = toDateStamp(filters.dateTo);
    return from === to ? `${name}_${from}.${format}` : `${name}_${from}_to_${to}.${format}`;
  }
  const dateStamp = toDateStamp(filters.dateTo ?? filters.dateFrom);
  return `${name}_${dateStamp}.${format}`;
}
