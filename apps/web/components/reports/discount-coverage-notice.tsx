import { ExportLimitNotice } from '@/components/reports/export-limit-notice';

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
      {showExportLimits && <ExportLimitNotice count={transactionCount} noun="sales" />}
    </div>
  );
}
