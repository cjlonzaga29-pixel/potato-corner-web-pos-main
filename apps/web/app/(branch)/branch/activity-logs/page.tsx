'use client';

import { HistoricalShiftRecords } from '@/components/branch-ops/historical-shift-records';

/**
 * The Audit Log tab that used to live here was retired (P1 cost/audit UI
 * retirement) — AuditLog data and recordAuditLog() are unaffected server-side,
 * this page just no longer surfaces them. Historical Shift Records is kept as
 * read-only archival history (pre-CR-004 shift/cash-reconciliation data), not
 * part of the removed cost-accounting UI.
 */
export default function BranchActivityLogsPage() {
  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="app-title font-bold">Activity Logs</h1>
        <p className="text-sm text-muted-foreground">Historical shift and cash-reconciliation records for your branch.</p>
      </div>

      <HistoricalShiftRecords />
    </div>
  );
}
