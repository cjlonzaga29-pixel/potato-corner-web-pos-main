import type { ReportType } from '@potato-corner/shared';
import type { ReportFilters } from '../../modules/reports/reports.types.js';

/** DAILY_SALES -> DailySales */
function pascalCase(reportType: ReportType): string {
  return reportType
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join('');
}

function toDateStamp(date: Date | undefined): string {
  return (date ?? new Date()).toISOString().slice(0, 10);
}

/**
 * User-facing download filename for a report export — e.g. `DailySales_2026-07-30.csv`.
 * Distinct from the Supabase Storage object path (`reports/{userId}/{timestamp}-{type}.{ext}`),
 * which only needs to be unique, not readable.
 */
export function buildExportFilename(reportType: ReportType, format: 'csv' | 'pdf', filters: ReportFilters): string {
  const dateStamp = toDateStamp(filters.dateTo ?? filters.dateFrom);
  return `${pascalCase(reportType)}_${dateStamp}.${format}`;
}
