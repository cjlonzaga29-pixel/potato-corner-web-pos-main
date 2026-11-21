import { REPORT_EXPORT_ROW_LIMITS } from '@potato-corner/shared';

interface ExportLimitNoticeProps {
  /** Records matching the filters an export of this tab would use. */
  count: number;
  /** Plural, for example "sales". */
  noun: string;
}

/** POS-PERF-P59 — warns before a CSV or PDF would be cut short, using the same limits as the API. Nothing to say otherwise. */
export function ExportLimitNotice({ count, noun }: ExportLimitNoticeProps) {
  const limitedFormats = (['pdf', 'csv'] as const).filter((format) => count > REPORT_EXPORT_ROW_LIMITS[format]);
  if (limitedFormats.length === 0) return null;
  return (
    <p role="status" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
      <strong>Exports will be partial.</strong> {limitedFormats.map((format) => `${format.toUpperCase()} holds the newest ${REPORT_EXPORT_ROW_LIMITS[format].toLocaleString('en-PH')} ${noun}`).join('; ')}, and {count.toLocaleString('en-PH')} match. A partial file says so at the top and in its name. Choose a shorter date range to export them all.
    </p>
  );
}
