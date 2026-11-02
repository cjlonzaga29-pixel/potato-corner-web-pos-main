import { REPORT_EXPORT_ROW_LIMITS } from '@potato-corner/shared';

interface DiscountCoverageNoticeProps {
  /** Rows in this response against the API's own total for the same filters. */
  rowsReturned: number;
  rowsTotal: number;
  transactionCount: number;
  /** The Supervisor and Branch exports list each sale, so they have row limits. Admin's exports the summary rows. */
  showExportLimits?: boolean;
}

/** POS-PERF-P59 — says whether the figures below describe every matching sale, and warns before an export would be cut short. */
export function DiscountCoverageNotice({ rowsReturned, rowsTotal, transactionCount, showExportLimits = false }: DiscountCoverageNoticeProps) {
  const totalsArePartial = rowsTotal > rowsReturned;
  const limitedFormats = showExportLimits
    ? (['pdf', 'csv'] as const).filter((format) => transactionCount > REPORT_EXPORT_ROW_LIMITS[format])
    : [];
  const count = transactionCount.toLocaleString('en-PH');

  return (
    <div className="space-y-2 text-sm">
      {totalsArePartial ? (
        <p role="alert" className="rounded-md border border-warning bg-warning/10 p-3">
          <strong>Partial totals.</strong> These totals and the type list cover only the first {rowsReturned.toLocaleString('en-PH')} of{' '}
          {rowsTotal.toLocaleString('en-PH')} summary rows, so more sales match than the {count} counted here. Choose a shorter date range for complete totals.
        </p>
      ) : (
        <p className="text-muted-foreground">Totals cover all {count} matching discounted sales.</p>
      )}
      {limitedFormats.length > 0 && (
        <p role="status" className="rounded-md border border-warning bg-warning/10 p-3">
          <strong>Exports will be partial.</strong> {limitedFormats.map((format) => `${format.toUpperCase()} holds the newest ${REPORT_EXPORT_ROW_LIMITS[format].toLocaleString('en-PH')} sales`).join('; ')}, and {count} match. A partial file says so at the top and in its name. Choose a shorter date range to export them all.
        </p>
      )}
    </div>
  );
}
