// apps/api/src/lib/reports/export-filename.test.ts
import { describe, it, expect } from 'vitest';
import { buildExportFilename } from './export-filename.js';
import { manilaDateKey } from '../manila-time.js';
import type { ReportFilters } from '../../modules/reports/reports.types.js';

describe('buildExportFilename', () => {
  it('builds a PascalCase report name with a from_to date range stamp when both bounds are known', () => {
    const filters: ReportFilters = { dateFrom: new Date('2026-07-24'), dateTo: new Date('2026-07-30'), page: 1, limit: 100 };
    expect(buildExportFilename('DAILY_SALES', 'csv', filters)).toBe('DailySales_2026-07-24_to_2026-07-30.csv');
    expect(buildExportFilename('CASH_RECONCILIATION', 'pdf', filters)).toBe('CashReconciliation_2026-07-24_to_2026-07-30.pdf');
  });

  it('collapses to the single-date form when date_from and date_to resolve to the same Manila calendar day', () => {
    // Same Manila day-start/day-end boundary pair a real request produces for
    // a single-day filter (see reports.router.ts's toBoundaryDate) — must NOT
    // render as "..._2026-07-24_to_2026-07-24...".
    const filters: ReportFilters = {
      dateFrom: new Date('2026-07-24T00:00:00.000+08:00'),
      dateTo: new Date('2026-07-24T23:59:59.999+08:00'),
      page: 1,
      limit: 100,
    };
    expect(buildExportFilename('DAILY_SALES', 'csv', filters)).toBe('DailySales_2026-07-24.csv');
  });

  it('falls back to date_from when date_to is missing, and to today when both are missing', () => {
    const withFromOnly: ReportFilters = { dateFrom: new Date('2026-07-01'), page: 1, limit: 100 };
    expect(buildExportFilename('AUDIT_LOG', 'csv', withFromOnly)).toBe('AuditLog_2026-07-01.csv');

    const withNeither: ReportFilters = { page: 1, limit: 100 };
    const today = manilaDateKey(new Date());
    expect(buildExportFilename('FRAUD_ALERT_SUMMARY', 'csv', withNeither)).toBe(`FraudAlertSummary_${today}.csv`);
  });

  it('stamps the Manila calendar date, not the UTC one, for a date_from that is a Manila day-start boundary', () => {
    // dayBounds' start-of-day boundary for Manila 2026-07-30 — one instant
    // most callers ever pass here (see reports.router.ts's toBoundaryDate).
    // Its UTC calendar day (2026-07-29) is one day earlier than the Manila
    // date it actually represents.
    const manilaJuly30Start = new Date('2026-07-29T16:00:00.000Z');
    const withFromOnly: ReportFilters = { dateFrom: manilaJuly30Start, page: 1, limit: 100 };

    expect(buildExportFilename('AUDIT_LOG', 'csv', withFromOnly)).toBe('AuditLog_2026-07-30.csv');
  });
});
