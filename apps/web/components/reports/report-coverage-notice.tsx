import { ExportLimitNotice } from '@/components/reports/export-limit-notice';

interface ReportCoverageNoticeProps {
  /** Every record matching this tab's filters, from the API. Undefined until it has loaded. */
  count: number | undefined;
  /** Plural, for example "completed sales". */
  noun: string;
  /** Whether cards above the table describe those records. False when a tab has none or they couldn't load. */
  hasTotals: boolean;
}

/** POS-PERF-P59 — says what a report tab's figures cover, that its table pages through all of it, and when its exports would be cut short. */
export function ReportCoverageNotice({ count, noun, hasTotals }: ReportCoverageNoticeProps) {
  if (count === undefined) return null;
  const formatted = count.toLocaleString('en-PH');
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        {hasTotals ? `Totals cover all ${formatted} ${noun} in this period.` : `${formatted} ${noun} match.`} The table shows one page of them at a time.
      </p>
      <ExportLimitNotice count={count} noun={noun} />
    </div>
  );
}
